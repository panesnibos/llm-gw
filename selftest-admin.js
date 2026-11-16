'use strict'
// Self-check for the admin API. Spawns a throwaway gateway on temp ports with a
// temp keys.json and an unreachable upstream, so it never touches production.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gw-test-'))
const PORT = 18980
const ADMIN_PORT = 18981
const ADMIN_KEY = 'test-admin-key'
const env = {
  ...process.env,
  PORT, ADMIN_PORT, HOST: '127.0.0.1', ADMIN_HOST: '127.0.0.1', ADMIN_KEY,
  UPSTREAM_BASE: 'http://127.0.0.1:1/v1', UPSTREAM_KEYS: 'sk-dummy',
  CLIENT_KEYS: 'seed:sk-gw-000000000000000000000000000000000000000000000000', KEYS_FILE: path.join(dir, 'keys.json'), LOG_FILE: path.join(dir, 'usage.jsonl'),
}
const A = `http://127.0.0.1:${ADMIN_PORT}`
const adm = (p, opt = {}) => fetch(A + p, { ...opt, headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json', ...(opt.headers || {}) } })
const pub = key => fetch(`http://127.0.0.1:${PORT}/v1/models`, { headers: { authorization: 'Bearer ' + key } })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const fails = []
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' (' + extra + ')' : ''))
  if (!cond) fails.push(name)
}

;(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: 'ignore' })
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(A + '/admin/status'); break } catch { await sleep(100) }
    }

    let r = await fetch(A + '/admin/status')
    ok('admin needs key', r.status === 401, 'status=' + r.status)

    r = await adm('/admin/status')
    const st = await r.json()
    ok('status 200', r.status === 200)
    ok('seed migrated to keys.json', fs.existsSync(env.KEYS_FILE))
    ok('one client', st.clients === 1, JSON.stringify(st.today))

    r = await adm('/admin/keys')
    const kj = await r.json()
    ok('key listed masked', kj.keys.length === 1 && kj.keys[0].masked.includes('…'), kj.keys[0] && kj.keys[0].masked)
    ok('plain key not returned', !JSON.stringify(kj).includes('sk-gw-seed'))

    r = await adm('/admin/keys', { method: 'POST', body: JSON.stringify({ label: 'friend' }) })
    const nk = await r.json()
    ok('create key 201', r.status === 201 && nk.key.startsWith('sk-gw-'))
    r = await adm('/admin/keys', { method: 'POST', body: JSON.stringify({ label: 'friend' }) })
    ok('duplicate label 409', r.status === 409)
    r = await adm('/admin/keys', { method: 'POST', body: JSON.stringify({ label: 'bad label!' }) })
    ok('bad label 400', r.status === 400)

    r = await pub(nk.key)
    ok('new key works without restart', r.status !== 401, 'status=' + r.status)

    r = await adm('/admin/keys/friend', { method: 'DELETE' })
    ok('delete 200', r.status === 200)
    r = await pub(nk.key)
    ok('revoked key rejected', r.status === 401)
    r = await adm('/admin/keys/friend', { method: 'DELETE' })
    ok('delete missing 404', r.status === 404)

    r = await adm('/admin/usage?hours=24')
    const u = await r.json()
    ok('usage aggregates', u.totals && typeof u.totals.requests === 'number', 'requests=' + (u.totals && u.totals.requests))
    r = await adm('/admin/errors?limit=5')
    const e = await r.json()
    ok('errors list', Array.isArray(e.errors))
  } catch (err) {
    ok('no exception', false, err.message)
  } finally {
    child.kill()
  }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  console.log(fails.length ? `FAILURES: ${fails.join(', ')}` : 'ALL PASS')
  process.exit(fails.length ? 1 : 0)
})()
