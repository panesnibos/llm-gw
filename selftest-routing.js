'use strict'
// Routing check: two fake upstreams, no network, no production. Verifies failover
// on account-level failure, the breaker, pin prefix, model catalog and reset.
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gw-route-'))
const PORT = 18992
const ADMIN_PORT = 18993
const ADMIN_KEY = 'route-test-key'
const P_PORT = 18990
const B_PORT = 18991

const calls = { primary: 0, backup: 0 }
const seen = { backup: [] }

const fake = (port, handler) =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => handler(req, res, body))
    })
    s.listen(port, '127.0.0.1', () => resolve(s))
  })

const jsonRes = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const routesPath = path.join(dir, 'upstreams.json')
fs.writeFileSync(
  routesPath,
  JSON.stringify(
    {
      upstreams: {
        primary: { base: `http://127.0.0.1:${P_PORT}/v1`, keys: ['k1'] },
        backup: { base: `http://127.0.0.1:${B_PORT}/v1`, keys: ['k2'] },
      },
      models: {
        'prem/deepseek-v4.1-flash-1017': [
          { upstream: 'primary', model: 'prem/deepseek-v4.1-flash-1017' },
          { upstream: 'backup', model: 'ds-backup' },
        ],
      },
    },
    null,
    2
  )
)

const env = {
  ...process.env,
  PORT,
  ADMIN_PORT,
  HOST: '127.0.0.1',
  ADMIN_HOST: '127.0.0.1',
  ADMIN_KEY,
  ROUTES_FILE: routesPath,
  KEYS_FILE: path.join(dir, 'keys.json'),
  LOG_FILE: path.join(dir, 'usage.jsonl'),
  CLIENT_KEYS: 'tester:sk-gw-000000000000000000000000000000000000000000000000',
  BREAKER_MS: 60000,
  UPSTREAM_BASE: '',
  UPSTREAM_KEYS: '',
}

const A = `http://127.0.0.1:${ADMIN_PORT}`
const adm = (p, opt = {}) => fetch(A + p, { ...opt, headers: { 'x-admin-key': ADMIN_KEY, ...(opt.headers || {}) } })
const chat = (model) =>
  fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-gw-000000000000000000000000000000000000000000000000', 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' (' + extra + ')' : ''))
  if (!cond) fails.push(name)
}
const lastLog = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const text = fs.readFileSync(env.LOG_FILE, 'utf8').trim()
      if (text) {
        const lines = text.split('\n')
        return JSON.parse(lines[lines.length - 1])
      }
    } catch {}
    await sleep(50)
  }
  throw new Error('usage.jsonl kosong')
}

;(async () => {
  const servers = [
    await fake(P_PORT, (req, res) => {
      calls.primary++
      jsonRes(res, 402, { error: { message: 'quota habis' } })
    }),
    await fake(B_PORT, (req, res, body) => {
      calls.backup++
      const model = JSON.parse(body).model
      seen.backup.push(model)
      jsonRes(res, 200, {
        id: 'x',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }),
  ]

  const gw = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: 'ignore' })
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(A + '/admin/status'); break } catch { await sleep(100) }
    }

    let r = await chat('prem/deepseek-v4.1-flash-1017')
    ok('failover: client tetap 200', r.status === 200, 'status=' + r.status)
    let log = await lastLog()
    ok('log mencatat upstream backup', log.upstream === 'backup', JSON.stringify(log.tried))
    ok('log mencatat model yang dipakai di backup', log.target_model === 'ds-backup')
    ok('model ditulis ulang untuk upstream kedua', seen.backup[0] === 'ds-backup', seen.backup[0])
    ok('primary dicoba sekali lalu ditinggal', calls.primary === 1, 'primary=' + calls.primary)

    r = await chat('prem/deepseek-v4.1-flash-1017')
    ok('breaker: request berikut langsung ke backup', r.status === 200 && calls.primary === 1, 'primary=' + calls.primary)

    r = await adm('/admin/upstreams')
    const u = await r.json()
    const primary = u.upstreams.find((x) => x.name === 'primary')
    ok('admin/upstreams melaporkan cooldown', primary && primary.cooling_s > 0, primary && String(primary.cooling_s))
    ok('admin/upstreams menghitung model', u.upstreams.find((x) => x.name === 'backup').models === 1)

    r = await adm('/admin/upstreams/primary/reset', { method: 'POST' })
    ok('reset breaker 200', r.status === 200)
    const before = calls.primary
    r = await chat('prem/deepseek-v4.1-flash-1017')
    ok('setelah reset primary dicoba lagi', calls.primary === before + 1 && r.status === 200, 'primary=' + calls.primary)

    r = await chat('primary/prem/deepseek-v4.1-flash-1017')
    ok('pin prefix tidak failover', r.status >= 500, 'status=' + r.status)

    r = await chat('model/aneh')
    const bad = await r.json()
    ok('model tak dikenal 400', r.status === 400, 'status=' + r.status)
    ok('400 menyebut model yang tersedia', Array.isArray(bad.error && bad.error.available) && bad.error.available.length === 1)

    r = await fetch(`http://127.0.0.1:${PORT}/v1/models`, { headers: { authorization: 'Bearer sk-gw-000000000000000000000000000000000000000000000000' } })
    const cat = await r.json()
    ok('v1/models dari peta routing', cat.data.length === 1 && cat.data[0].id === 'prem/deepseek-v4.1-flash-1017')
  } catch (err) {
    ok('no exception', false, err.message)
  } finally {
    gw.kill()
    servers.forEach((s) => s.close())
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  console.log(fails.length ? `FAILURES: ${fails.join(', ')}` : 'ALL PASS')
  process.exit(fails.length ? 1 : 0)
})()
