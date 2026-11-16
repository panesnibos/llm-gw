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
| `CLIENT_KEYS` | — | `label:key,label:key` (fallback when `keys.json` is absent) |
| `LOG_FILE` | `./usage.jsonl` | JSONL, one line per request |
| `MAX_RETRIES` | `2` | extra attempts after the first (3 total) |

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
```

Expected: six `ok` lines and `ALL PASS`.

## Deploy

GitHub is the source of truth. Edit on the laptop, push, pull on the VPS.

```bash
ssh -p 20001 root@<vps> "cd /root/llm-gw && git pull && systemctl restart llm-gw && systemctl is-active llm-gw"
```

`.env`, `keys.json` and `usage.jsonl` are gitignored, so a pull never touches the
running config or the log.
