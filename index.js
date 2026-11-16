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

const CLIENTS = new Map()
for (const entry of (process.env.CLIENT_KEYS || '').split(',')) {
  const i = entry.indexOf(':')
  if (i < 0) continue
  const label = entry.slice(0, i).trim()
  const key = entry.slice(i + 1).trim()
  if (label && key) CLIENTS.set(sha(key), label)
}

if (!UP_KEYS.length) { console.error('UPSTREAM_KEYS empty'); process.exit(1) }
if (!CLIENTS.size) { console.error('CLIENT_KEYS empty'); process.exit(1) }

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
  const client = CLIENTS.get(sha(token))
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

server.listen(PORT, HOST, () => {
  console.log(`llm-gw on http://${HOST}:${PORT} -> ${UPSTREAM} (${UP_KEYS.length} upstream key, ${CLIENTS.size} client)`)
})

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)))
