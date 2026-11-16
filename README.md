# llm-gw

OpenAI-compatible LLM gateway. Zero dependencies, single file, Node 18+.

Sits between clients (OpenCode, bots, scripts) and one upstream provider. Gives you
per-client keys that can be rotated independently, key rotation for the upstream,
retry on transient failures, and a JSONL usage log. It also normalizes SSE so strict
parsers (OpenCode's `openai-compatible` provider) accept the stream.

```
client --(client key)--> llm-gw --(upstream key)--> upstream
                              |
                              +--> usage.jsonl
```

## Files

| File | Purpose |
|---|---|
| `index.js` | the whole gateway |
| `selftest.sh` | 6-check smoke test |
| `llm-gw.service` | systemd unit |
| `.env` | secrets, **not** in git |
| `keys.json` | client keys, **not** in git |

## Run

```bash
cp .env.example .env     # then fill it
node index.js
```

Service:

```bash
sudo cp llm-gw.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now llm-gw
```

## Configuration

Read from the environment (`.env` via the systemd unit).

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | public listener |
| `HOST` | `127.0.0.1` | keep on loopback; expose via tunnel |
| `ROUTES_FILE` | `/root/llm-gw/upstreams.json` | upstreams + model routing, hot-reloaded |
| `UPSTREAM_BASE` | `https://free.ai.id/v1` | only used when `upstreams.json` is missing |
| `UPSTREAM_KEYS` | — | same, comma-separated |
| `KEYS_FILE` | `/root/llm-gw/keys.json` | client keys, hot-reloaded |
| `CLIENT_KEYS` | — | `label:key,...`; only seeds `keys.json` on first run |
| `LOG_FILE` | `./usage.jsonl` | JSONL, one line per request |
| `ADMIN_HOST` | `127.0.0.1` | admin listener, loopback only |
| `ADMIN_PORT` | `8081` | not exposed through the tunnel |
| `ADMIN_KEY` | — | admin API disabled when empty |
| `BREAKER_MS` | `300000` | how long an upstream is skipped after `401`/`402` |
| `TOTAL_BUDGET_MS` | `90000` | ceiling for one request across all upstreams |

## Upstreams and routing

`upstreams.json` (chmod 600, gitignored, hot-reloaded) maps each client-facing model
name to an ordered list of upstreams:

```json
{
  "upstreams": {
    "freeai":  { "base": "https://free.ai.id/v1",       "keys": ["sk-..."] },
    "netraux": { "base": "https://ai.netraux.eu.cc/v1", "keys": ["zx-..."] }
  },
  "models": {
    "prem/glm-5.3-flash": [
      { "upstream": "freeai",  "model": "prem/glm-5.3-flash" },
      { "upstream": "netraux", "model": "free/glm-5.3-flash" }
    ],
    "free/gpt-6-luna": [
      { "upstream": "netraux", "model": "free/gpt-6-luna" }
    ]
  }
}
```

A request resolves like this:

1. `netraux/free/gpt-6-luna` — the first segment names an upstream, so it **pins** to
   `netraux` and sends `free/gpt-6-luna`. No failover.
2. `prem/glm-5.3-flash` — no upstream by that name, so the chain in `models` is walked
   in order. Each target is retried twice (700 ms apart) on network/`408`/`429`/`5xx`,
   then the next target is tried with its own model name.
3. A model that is in neither place gets `400` with the list of routed models.
4. A `401`/`402` from an upstream trips a breaker (`BREAKER_MS`): that upstream is
   skipped entirely, so the next request goes straight to the backup.
5. Failover stops once streaming has started — the bytes are already on the wire.

An upstream name must not match the first segment of a mapped model, otherwise the
config is rejected on load with a message saying so. `/v1/models` is generated from
the `models` map, so clients see exactly what is routed.

## Client keys

`keys.json` is the source of truth (`{"label": "sk-gw-..."}`, chmod 600). It is
re-read on every request when its mtime changes, so adding or revoking a key needs
no restart. `CLIENT_KEYS` in `.env` is only read when `keys.json` is missing, and
the file is written from it once — after that `.env` is ignored for keys.

## Admin API

Second listener on `127.0.0.1:8081`. The tunnel maps `PORT` only, so the admin API
is unreachable from the internet. Auth: header `x-admin-key`, compared in constant
time.

| Endpoint | Returns |
|---|---|
| `GET /admin/status` | uptime, client/model counts, today's requests/tokens/errors, last 5 min per upstream, breaker state, last request |
| `GET /admin/upstreams` | every upstream with base, key count, mapped models, remaining cooldown |
| `GET /admin/models` | today's tokens per client-facing model, biggest first (pins folded into the bare id) |
| `POST /admin/upstreams/:name/reset` | clears the breaker for one upstream |
| `GET /admin/usage?hours=24` | per-client requests, tokens, errors, avg latency |
| `GET /admin/errors?limit=10` | newest first, entries with status ≥ 400 |
| `GET /admin/keys` | labels with masked keys |
| `POST /admin/keys` `{"label":"x"}` | creates a key, returns it **once** |
| `DELETE /admin/keys/:label` | revokes it |

```bash
curl -s -H "x-admin-key: $ADMIN_KEY" http://127.0.0.1:8081/admin/status
curl -s -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"label":"friend"}' http://127.0.0.1:8081/admin/keys
```

## Behaviour

- Auth: `Authorization: Bearer <client key>`. Keys are compared as SHA-256 hashes.
- Retry: network error, `408`, `429`, `5xx` — twice per upstream, then fail over to the
  next upstream in the model's chain. Client errors (`4xx`) are never retried.
- Streaming: SSE frames are rewritten to one JSON value per `data:` line, comments
  dropped, single `[DONE]`. This is what makes it usable from OpenCode.
  `stream_options.include_usage` is injected so token counts are logged for streams too;
  failover stops once the first byte is on the wire.
- Usage log: `{ts, client, method, path, status, attempts, ms, requested_model, upstream,
  target_model, tried, model, prompt_tokens, completion_tokens, stream, sse_frames}`.

## Test

```bash
./selftest.sh http://127.0.0.1:8080 sk-gw-...
node selftest-admin.js       # admin API, throwaway instance, touches nothing
node selftest-routing.js     # failover/breaker/pin against two fake upstreams
```

Expected: `ALL PASS` from all three.

## Deploy

GitHub is the source of truth. Edit on the laptop, push, pull on the VPS.

```bash
ssh -p 20001 root@<vps> "cd /root/llm-gw && git pull && systemctl restart llm-gw && systemctl is-active llm-gw"
```

`.env`, `keys.json` and `usage.jsonl` are gitignored, so a pull never touches the
running config or the log.
