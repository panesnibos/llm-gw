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
| `UPSTREAM_BASE` | `https://free.ai.id/v1` | must include `/v1` |
| `UPSTREAM_KEYS` | — | comma-separated, rotated round-robin |
| `KEYS_FILE` | `/root/llm-gw/keys.json` | client keys, hot-reloaded |
| `CLIENT_KEYS` | — | `label:key,...`; only seeds `keys.json` on first run |
| `LOG_FILE` | `./usage.jsonl` | JSONL, one line per request |
| `ADMIN_HOST` | `127.0.0.1` | admin listener, loopback only |
| `ADMIN_PORT` | `8081` | not exposed through the tunnel |
| `ADMIN_KEY` | — | admin API disabled when empty |
| `MAX_RETRIES` | `2` | extra attempts after the first (3 total) |

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
| `GET /admin/status` | uptime, client count, today's requests/tokens/errors, last 5 min error counts, last request |
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
- Retry: network error, `408`, `429`, `5xx`. Client errors (`4xx`) are not retried.
- Streaming: SSE frames are rewritten to one JSON value per `data:` line, comments
  dropped, single `[DONE]`. This is what makes it usable from OpenCode.
- Usage log: `{ts, client, method, path, status, attempts, ms, model, prompt_tokens,
  completion_tokens, stream, sse_frames}`.

## Test

```bash
./selftest.sh http://127.0.0.1:8080 sk-gw-...
node selftest-admin.js       # spawns a throwaway instance, touches nothing
```

Expected: `ALL PASS` from both.

## Deploy

GitHub is the source of truth. Edit on the laptop, push, pull on the VPS.

```bash
ssh -p 20001 root@<vps> "cd /root/llm-gw && git pull && systemctl restart llm-gw && systemctl is-active llm-gw"
```

`.env`, `keys.json` and `usage.jsonl` are gitignored, so a pull never touches the
running config or the log.
