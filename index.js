'use strict'
// LLM gateway: bearer auth, upstream key rotation, JSONL usage log. Zero deps.
const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '127.0.0.1'
const UPSTREAM = (process.env.UPSTREAM_BASE || 'https://free.ai.id/v1').replace(/\/+$/, '')
const UP_KEYS = (process.env.UPSTREAM_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)
const LOG_FILE = process.env.LOG_FILE || '/root/llm-gw/usage.jsonl'
const MAX_BODY = 25 * 1024 * 1024
const UP_TIMEOUT_MS = 120000
const MODELS_TTL_MS = 300000
const MAX_RETRIES = 2
const RETRY_DELAYS = [700, 1500]
// 4xx request errors are not retried: same request would fail the same way
const retryable = s => s === 408 || s === 429 || s >= 500
const sleep = ms => new Promise(r => setTimeout(r, ms))

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')

const KEYS_FILE = process.env.KEYS_FILE || '/root/llm-gw/keys.json'
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim()
const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1'
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8081)
const STARTED_AT = Date.now()

let keys = {}           // label -> key (plaintext, file is chmod 600)
let clients = new Map() // sha(key) -> label
let keysStamp = -1

const seedFromEnv = () => {
  const out = {}
  for (const entry of (process.env.CLIENT_KEYS || '').split(',')) {
    const i = entry.indexOf(':')
    if (i < 0) continue
    const label = entry.slice(0, i).trim()
    const key = entry.slice(i + 1).trim()
    if (label && key) out[label] = key
  }
  return out
}

function applyKeys(obj) {
  keys = {}
  clients = new Map()
  for (const [label, key] of Object.entries(obj || {})) {
    if (!label || typeof key !== 'string' || !key.trim()) continue
    keys[label] = key.trim()
    clients.set(sha(key.trim()), label)
  }
}

function writeKeys() {
  const tmp = KEYS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, KEYS_FILE)
  try { keysStamp = fs.statSync(KEYS_FILE).mtimeMs } catch {}
}

// keys.json is authoritative; CLIENT_KEYS in .env only seeds it once so an
// existing deployment migrates without re-creating every client key.
// Called per request: one statSync, reload only when the file changed.
function loadKeys() {
  try {
    const st = fs.statSync(KEYS_FILE)
    if (st.mtimeMs === keysStamp) return
    applyKeys(JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')))
    keysStamp = st.mtimeMs
    if (clients.size) return
  } catch {
    if (clients.size) return // keep last known-good keys on a transient read error
  }
  const seed = seedFromEnv()
  applyKeys(seed)
  if (clients.size) { try { writeKeys() } catch (err) { console.error('cannot write ' + KEYS_FILE + ': ' + err.message) } }
}

const randomKey = () => 'sk-gw-' + crypto.randomBytes(24).toString('hex')
const maskKey = k => k.slice(0, 11) + '…' + k.slice(-4)

loadKeys()
if (!UP_KEYS.length) { console.error('UPSTREAM_KEYS empty'); process.exit(1) }
if (!clients.size) { console.error(`${KEYS_FILE} has no keys and CLIENT_KEYS is empty`); process.exit(1) }

function log(rec) {
  fs.appendFile(LOG_FILE, JSON.stringify(rec) + '\n', () => {})
}
function send(res, status, body, ct = 'application/json') {
  res.writeHead(status, { 'content-type': ct, 'cache-control': 'no-store' })
  res.end(body)
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj))

// OpenCode's openai-compatible SSE parser rejects frames carrying more than one
// JSON value, and counts a stream as finished only on a real finish_reason frame.
// Normalize: one JSON per data line, comments dropped, single [DONE].
function splitJsonValues(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break
    const start = i
    let depth = 0
    let inStr = false
    let esc = false
    for (; i < text.length; i++) {
      const c = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        if (--depth === 0) { i++; break }
      }
    }
    out.push(text.slice(start, i))
  }
  return out
}

function sseNormalizer() {
  let buf = ''
  let doneSent = false
  const emit = v => {
    if (doneSent) return ''
    if (v === '[DONE]') { doneSent = true; return 'data: [DONE]\n\n' }
    return 'data: ' + v + '\n\n'
  }
  const rewrite = frame => {
    const data = []
    const meta = []
    for (const line of frame.split(/\r\n|\r|\n/)) {
      if (!line || line[0] === ':') continue
      const i = line.indexOf(':')
      const field = i === -1 ? line : line.slice(0, i)
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'data') data.push(value)
      else if (field === 'event' || field === 'id' || field === 'retry') meta.push(line)
      else data.push(line)
    }
    if (!data.length) return ''
    const joined = data.join('\n')
    let values
    if (joined.trim() === '[DONE]') values = ['[DONE]']
    else {
      try { JSON.parse(joined); values = [joined] } catch {
        values = []
        for (const d of data) {
          if (d.trim() === '[DONE]') { values.push('[DONE]'); continue }
          try { JSON.parse(d); values.push(d) } catch { values.push(...splitJsonValues(d)) }
        }
      }
    }
    let out = ''
    let first = true
    for (const raw of values) {
      const v = raw.trim()
      if (!v) continue
      if (v !== '[DONE]') {
        try { JSON.parse(v) } catch { continue }
      }
      if (first && meta.length) { out += meta.join('\n') + '\n'; first = false }
      out += emit(v)
    }
    return out
  }
  return {
    push(chunk) {
      buf += chunk.toString('utf8')
      let out = ''
      for (;;) {
        const m = /(?:\r\n|\r|\n){2}/.exec(buf)
        if (!m) break
        const frame = buf.slice(0, m.index)
        buf = buf.slice(m.index + m[0].length)
        out += rewrite(frame)
      }
      return out
    },
    flush() {
      const rest = buf.trim() ? rewrite(buf) : ''
      buf = ''
      return rest
    },
  }
}

let rr = 0
let modelsCache = null

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  let url
  try { url = new URL(req.url, 'http://localhost') } catch { return json(res, 400, { error: { message: 'bad url' } }) }

  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain')

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  loadKeys()
  const client = clients.get(sha(token))
  if (!client) {
    log({ ts: new Date().toISOString(), client: null, method: req.method, path: url.pathname, status: 401, ms: 0 })
    return json(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } })
  }

  if (req.method === 'GET' && url.pathname === '/v1/models' && modelsCache && modelsCache.exp > Date.now()) {
    return send(res, 200, modelsCache.body, modelsCache.ct)
  }

  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) { json(res, 413, { error: { message: 'body too large' } }); return }
        chunks.push(chunk)
      }
    } catch { return json(res, 400, { error: { message: 'request read error' } }) }
    body = Buffer.concat(chunks)
  }

  const abort = new AbortController()
  res.on('close', () => abort.abort())

  // UPSTREAM already carries the /v1 base, so drop the version prefix from the incoming path
  const target = UPSTREAM + url.pathname.replace(/^\/v1(?=\/|$)/, '') + url.search
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', authorization: '' }
  if (req.headers.accept) headers.accept = req.headers.accept

  let up
  let attempts = 0
  for (let i = 0; i <= MAX_RETRIES; i++) {
    attempts++
    headers.authorization = 'Bearer ' + UP_KEYS[rr++ % UP_KEYS.length]
    try {
      up = await fetch(target, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.any([AbortSignal.timeout(UP_TIMEOUT_MS), abort.signal]),
      })
    } catch {
      up = undefined
    }
    if (up && !retryable(up.status)) break
    if (i === MAX_RETRIES) break
    if (up) { try { await up.body?.cancel() } catch {} }
    up = undefined
    await sleep(RETRY_DELAYS[i])
  }

  const base = { ts: new Date().toISOString(), client, method: req.method, path: url.pathname, attempts, ms: 0 }
  if (process.env.DEBUG_BODY) fs.appendFileSync('/root/llm-gw/debug.jsonl', JSON.stringify({ ts: base.ts, path: url.pathname, body: body ? body.toString('utf8') : null }) + '\n')
  if (!up) {
    const status = abort.signal.aborted ? 499 : 504
    log({ ...base, status })
    return json(res, status, { error: { message: status === 499 ? 'client closed' : 'upstream unreachable' } })
  }
  base.status = up.status

  const ct = up.headers.get('content-type') || 'application/json'
  try {
    if (ct.includes('text/event-stream') && up.body) {
      res.writeHead(up.status, { 'content-type': ct, 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      const norm = sseNormalizer()
      let events = 0
      for await (const chunk of up.body) {
        const out = norm.push(Buffer.from(chunk))
        if (out) { events++; res.write(out) }
      }
      const tail = norm.flush()
      if (tail) { events++; res.write(tail) }
      res.end()
      log({ ...base, stream: true, sse_frames: events, ms: Date.now() - started })
      return
    }
    const text = await up.text()
    let usage = {}
    let model
    try {
      const parsed = JSON.parse(text)
      usage = parsed.usage || {}
      model = parsed.model
    } catch {}
    if (req.method === 'GET' && url.pathname === '/v1/models' && up.status === 200) {
      modelsCache = { body: text, ct, exp: Date.now() + MODELS_TTL_MS }
    }
    res.writeHead(up.status, { 'content-type': ct, 'cache-control': 'no-store' })
    res.end(text)
    log({ ...base, model, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, ms: Date.now() - started })
  } catch (err) {
    log({ ...base, error: String(err && err.name), ms: Date.now() - started })
    if (!res.headersSent) json(res, 502, { error: { message: 'upstream stream error' } })
    else res.destroy()
  }
})

// --- admin API -------------------------------------------------------------
// Separate listener on loopback: the public tunnel maps PORT only, so admin
// cannot be reached from the internet even if its key leaks.
const ADMIN_BODY_MAX = 64 * 1024
const DAY_MS = 24 * 3600 * 1000

function readTail(maxBytes) {
  try {
    const st = fs.statSync(LOG_FILE)
    const from = Math.max(0, st.size - maxBytes)
    const buf = Buffer.alloc(st.size - from)
    const fd = fs.openSync(LOG_FILE, 'r')
    try { fs.readSync(fd, buf, 0, buf.length, from) } finally { fs.closeSync(fd) }
    let text = buf.toString('utf8')
    if (from > 0) text = text.slice(text.indexOf('\n') + 1) // drop the cut line
    return text
  } catch { return '' }
}

// shortcut: aggregates scan at most the last 8 MB of usage.jsonl, so very old
// windows under-report. Move to rolling counters if history grows past that.
function scanLog(fn) {
  for (const line of readTail(8 * 1024 * 1024).split('\n')) {
    if (!line) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (typeof rec.path === 'string' && rec.path.startsWith('/admin')) continue
    fn(rec)
  }
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : 0)

function statusSnapshot() {
  const now = Date.now()
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const win = now - 5 * 60000
  const today = { requests: 0, tokens: 0, errors: 0 }
  const last5m = { requests: 0, s5xx: 0, s429: 0, s402: 0 }
  let last = null
  scanLog(r => {
    const t = Date.parse(r.ts) || 0
    if (t >= dayStart.getTime()) {
      today.requests++
      today.tokens += num(r.prompt_tokens) + num(r.completion_tokens)
      if (num(r.status) >= 400) today.errors++
    }
    if (t >= win) {
      last5m.requests++
      if (num(r.status) >= 500) last5m.s5xx++
      if (num(r.status) === 429) last5m.s429++
      if (num(r.status) === 402) last5m.s402++
    }
    if (!last || t >= (Date.parse(last.ts) || 0)) {
      last = { ts: r.ts, client: r.client ?? null, status: num(r.status), ms: num(r.ms), attempts: num(r.attempts), path: r.path }
    }
  })
  return {
    ok: true,
    now: new Date(now).toISOString(),
    uptime_s: Math.round((now - STARTED_AT) / 1000),
    upstream: UPSTREAM,
    ports: { public: PORT, admin: ADMIN_PORT },
    clients: clients.size,
    models_cache_age_s: modelsCache ? Math.round((now - modelsCache.exp + MODELS_TTL_MS) / 1000) : null,
    today,
    last_5m: last5m,
    last_request: last,
  }
}

function aggregate(hours) {
  const since = Date.now() - hours * 3600 * 1000
  const rows = new Map()
  const totals = { requests: 0, prompt_tokens: 0, completion_tokens: 0, errors: 0 }
  scanLog(r => {
    const t = Date.parse(r.ts) || 0
    if (t < since) return
    const label = r.client || '(no key)'
    const row = rows.get(label) || { client: label, requests: 0, prompt_tokens: 0, completion_tokens: 0, errors: 0, ms_sum: 0, ms_n: 0, last: null }
    row.requests++
    row.prompt_tokens += num(r.prompt_tokens)
    row.completion_tokens += num(r.completion_tokens)
    if (num(r.status) >= 400) { row.errors++; totals.errors++ }
    if (num(r.ms)) { row.ms_sum += num(r.ms); row.ms_n++ }
    if (!row.last || t >= (Date.parse(row.last) || 0)) row.last = r.ts
    totals.requests++
    totals.prompt_tokens += num(r.prompt_tokens)
    totals.completion_tokens += num(r.completion_tokens)
    rows.set(label, row)
  })
  const out = [...rows.values()]
    .map(r => ({ client: r.client, requests: r.requests, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, errors: r.errors, avg_ms: r.ms_n ? Math.round(r.ms_sum / r.ms_n) : 0, last: r.last }))
    .sort((a, b) => b.requests - a.requests)
  return { hours, since: new Date(since).toISOString(), totals, clients: out }
}

function recentErrors(limit) {
  const out = []
  scanLog(r => {
    if (num(r.status) >= 400 || r.error) out.push({ ts: r.ts, client: r.client ?? null, path: r.path, status: num(r.status), attempts: num(r.attempts), error: r.error })
  })
  return out.slice(-limit).reverse()
}

const constantEq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex'))

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > ADMIN_BODY_MAX) throw new Error('body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const admin = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (!ADMIN_KEY) return json(res, 503, { error: { message: 'ADMIN_KEY not set' } })
  if (!constantEq(String(req.headers['x-admin-key'] || ''), ADMIN_KEY)) {
    return json(res, 401, { error: { message: 'invalid admin key' } })
  }
  const p = url.pathname

  if (req.method === 'GET' && p === '/admin/status') return json(res, 200, statusSnapshot())
  if (req.method === 'GET' && p === '/admin/usage') {
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24))
    return json(res, 200, aggregate(hours))
  }
  if (req.method === 'GET' && p === '/admin/errors') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 10))
    return json(res, 200, { errors: recentErrors(limit) })
  }
  if (req.method === 'GET' && p === '/admin/keys') {
    loadKeys()
    return json(res, 200, { keys: Object.entries(keys).map(([label, key]) => ({ label, masked: maskKey(key) })) })
  }
  if (req.method === 'POST' && p === '/admin/keys') {
    let input
    try { input = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { error: { message: 'invalid json' } }) }
    const label = String(input.label || '').trim()
    if (!/^[a-z0-9_-]{1,32}$/i.test(label)) return json(res, 400, { error: { message: 'label must match [a-z0-9_-]{1,32}' } })
    loadKeys()
    if (keys[label]) return json(res, 409, { error: { message: 'label already exists' } })
    const key = input.key ? String(input.key).trim() : randomKey()
    if (!key.startsWith('sk-')) return json(res, 400, { error: { message: 'key must start with sk-' } })
    keys[label] = key
    clients.set(sha(key), label)
    writeKeys()
    console.log(`admin: added client ${label}`)
    return json(res, 201, { label, key, note: 'shown once, not stored in retrievable form elsewhere' })
  }
  if (req.method === 'DELETE' && p.startsWith('/admin/keys/')) {
    const label = decodeURIComponent(p.slice('/admin/keys/'.length))
    loadKeys()
    if (!keys[label]) return json(res, 404, { error: { message: 'no such label' } })
    delete keys[label]
    applyKeys(keys)
    writeKeys()
    console.log(`admin: revoked client ${label}`)
    return json(res, 200, { deleted: label })
  }
  return json(res, 404, { error: { message: 'not found' } })
})
admin.on('clientError', (err, socket) => { try { socket.destroy() } catch {} })

server.listen(PORT, HOST, () => {
  console.log(`llm-gw on http://${HOST}:${PORT} -> ${UPSTREAM} (${UP_KEYS.length} upstream key, ${clients.size} client)`)
  if (!ADMIN_KEY) return console.log('admin api disabled: ADMIN_KEY not set')
  admin.listen(ADMIN_PORT, ADMIN_HOST, () => console.log(`admin api on http://${ADMIN_HOST}:${ADMIN_PORT} (${KEYS_FILE})`))
})

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  admin.close()
  server.close(() => process.exit(0))
})
