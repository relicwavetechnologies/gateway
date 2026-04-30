# Gateway API — Curl Reference

A unified proxy that routes requests to **OpenAI** and **Gemini** (plus Claude) from a single endpoint.  
All you need is your API key and the right model name — the gateway figures out the rest.

---

## Base URL

```
http://localhost:4000
```

---

## Authentication

Every request to the proxy must carry your gateway API key. Use either form:

```
X-API-Key: cnsc_gw_<your-key>
```
or equivalently:
```
Authorization: Bearer cnsc_gw_<your-key>
```

Get your key from the admin panel (`POST /auth/login` → `GET /admin/api-keys`).

---

## The One Endpoint

Both OpenAI and Gemini go through the **same endpoint**:

```
POST /v1/chat/completions
```

The gateway auto-detects the provider by model name prefix:

| Model prefix | Routed to |
|---|---|
| `gemini-*` | Google Gemini |
| `gpt-*`, anything else | OpenAI |
| `claude-*` | Anthropic Claude (`POST /v1/messages`) |

---

## Available Models

### OpenAI Models

| Model name | Notes |
|---|---|
| `gpt-5.4` | Latest GPT-5 flagship |
| `gpt-5.4-mini` | Faster, lighter GPT-5 |
| `gpt-5.3-codex` | Codex-class model |

### Gemini Models

| Model name | Notes |
|---|---|
| `gemini-2.5-pro` | Most capable Gemini |
| `gemini-2.5-flash` | Fast & efficient |
| `gemini-2.5-flash-lite` | Lightest Gemini option |
| `gemini-3.1-pro` | Next-gen Gemini Pro |
| `gemini-3.1-flash` | Next-gen Gemini Flash |
| `gemini-3-pro` | Gemini 3 Pro |
| `gemini-3-flash` | Gemini 3 Flash |

> Any model with a `gemini-` prefix is routed to Gemini. If the model isn't in the supported list the gateway will reject it.

---

## Request Body

```json
{
  "model": "<model-name>",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user",   "content": "Hello!" }
  ],
  "stream": false,
  "max_tokens": 4096
}
```

| Field | Required | Description |
|---|---|---|
| `model` | ✅ | Model name from the tables above |
| `messages` | ✅ | Array of `{ role, content }` — same as OpenAI chat format |
| `stream` | ❌ | `true` for SSE streaming, `false` (default) for a single JSON response |
| `max_tokens` | ❌ | Max output tokens (default: 4096) |

---

## Curl Examples

### Health Check (no auth needed)

```bash
curl http://localhost:4000/health
```

Expected response:
```json
{ "ok": true, "ts": 1234567890 }
```

---

### OpenAI — Simple request

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cnsc_gw_<your-key>" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      { "role": "user", "content": "What is 2 + 2?" }
    ]
  }'
```

### OpenAI — With system prompt & max_tokens

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cnsc_gw_<your-key>" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      { "role": "system", "content": "You are a concise assistant. Reply in one sentence." },
      { "role": "user",   "content": "Explain quantum entanglement." }
    ],
    "max_tokens": 200
  }'
```

### OpenAI — Streaming

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cnsc_gw_<your-key>" \
  -N \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      { "role": "user", "content": "Write me a short poem about the sea." }
    ],
    "stream": true
  }'
```

> `-N` (or `--no-buffer`) is important for streaming — it tells curl to flush output immediately.

---

### Gemini — Simple request

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cnsc_gw_<your-key>" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [
      { "role": "user", "content": "What is 2 + 2?" }
    ]
  }'
```

### Gemini — With system prompt

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cnsc_gw_<your-key>" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      { "role": "system", "content": "You are a helpful coding assistant." },
      { "role": "user",   "content": "Write a Python function to reverse a string." }
    ],
    "max_tokens": 512
  }'
```

### Gemini — Streaming

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cnsc_gw_<your-key>" \
  -N \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [
      { "role": "user", "content": "Tell me a short story about a robot." }
    ],
    "stream": true
  }'
```

---

## Response Format

### Non-streaming (standard JSON)

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The answer is 4."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 8,
    "total_tokens": 20
  }
}
```

Your answer is always at: `choices[0].message.content`

### Streaming (SSE)

Each chunk arrives as a Server-Sent Event line:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"The "},"index":0}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"answer "},"index":0}]}

data: [DONE]
```

The stream ends with `data: [DONE]`.

---

## Error Responses

| HTTP status | Meaning |
|---|---|
| `401` | Missing or invalid API key |
| `403` | Key is not allowed to use this provider |
| `429` | All accounts for this provider are rate-limited |
| `503` | No active accounts available for this provider |
| `500` | Unexpected gateway or upstream error |

---

## Using `Authorization: Bearer` instead of `X-API-Key`

Both header forms are equivalent — pick whichever suits your client:

```bash
# Option A — custom header
-H "X-API-Key: cnsc_gw_<your-key>"

# Option B — standard Bearer
-H "Authorization: Bearer cnsc_gw_<your-key>"
```

---

## Quick Reference Cheatsheet

```bash
BASE="http://localhost:4000"
KEY="cnsc_gw_<your-key>"

# OpenAI
curl $BASE/v1/chat/completions -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hi!"}]}'

# OpenAI mini
curl $BASE/v1/chat/completions -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"Hi!"}]}'

# Gemini Pro
curl $BASE/v1/chat/completions -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"Hi!"}]}'

# Gemini Flash (faster)
curl $BASE/v1/chat/completions -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hi!"}]}'

# Streaming (add -N flag + "stream":true)
curl -N $BASE/v1/chat/completions -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","stream":true,"messages":[{"role":"user","content":"Hi!"}]}'
```

---

## Admin — Get Your API Key

### 1. Login

```bash
curl http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<admin-email>","password":"<admin-password>"}'
```

Response: `{ "token": "<jwt>" }`

### 2. List API keys

```bash
curl http://localhost:4000/admin/api-keys \
  -H "Authorization: Bearer <jwt>"
```

### 3. Create a new API key

```bash
curl http://localhost:4000/admin/api-keys \
  -X POST \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-key"}'
```

Response contains the full `key` value — **save it**, it won't be shown again.
