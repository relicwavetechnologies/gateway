# How the Gateway Works

## The Big Picture

```
Your App / Anyone
      │
      │  POST /v1/chat/completions
      │  X-API-Key: cnsc_gw_xxxx
      │  { "model": "gpt-5.4", ... }
      ▼
┌─────────────────────────────────────────────────────┐
│                   YOUR GATEWAY                       │
│                                                     │
│  1. Validates your API key                          │
│  2. Detects provider from model name                │
│     gpt-*    → OpenAI                               │
│     gemini-* → Gemini                               │
│     claude-* → Claude                               │
│  3. Picks one account (load balances)               │
│  4. Forwards request using that account's token     │
└─────────────────────────────────────────────────────┘
      │               │               │
      ▼               ▼               ▼
  ChatGPT         Gemini CLI      Anthropic
  Backend         Backend          API
  (OpenAI)        (Google)        (Claude)
```

---

## The Trick — How Accounts Work

```
                    ONE TIME SETUP
                    ──────────────
User runs script → Browser opens → Logs into ChatGPT/Gemini/Claude
                                          │
                              OAuth gives back a TOKEN
                              (same token their official
                               CLI app uses internally)
                                          │
                              Gateway saves token encrypted
                              in database
```

```
                    EVERY REQUEST
                    ─────────────
Your App                 Gateway                  AI Backend
   │                        │                         │
   │── POST /v1/chat ───────▶│                         │
   │   X-API-Key: yours      │                         │
   │                         │ picks saved token       │
   │                         │── forwards request ────▶│
   │                         │   Authorization: Bearer │
   │                         │   <their OAuth token>   │
   │                         │                         │
   │                         │◀── AI response ─────────│
   │◀── response ────────────│                         │
```

**The AI backend sees the request coming from their own CLI app — not from you.**
It has no way to tell the difference.

---

## Load Balancing — Multiple Accounts

```
You have 3 ChatGPT accounts connected:

  Request 1  ──▶  Account A (abhishek's chatgpt)
  Request 2  ──▶  Account B (abhishek-second)
  Request 3  ──▶  Account C (nothingn2)
  Request 4  ──▶  Account A  ← loops back
  Request 5  ──▶  Account B
  ...

  If Account A hits rate limit:
  ┌─ Account A marked rate_limited for 15 min
  └─ All requests go to B and C until A recovers
```

---

## API Keys — Who Uses What

```
Gateway API Keys are YOUR invention — OpenAI/Gemini don't know about them.

  cnsc_gw_key1  →  given to Project X   (can use openai + gemini)
  cnsc_gw_key2  →  given to Project Y   (only openai)
  cnsc_gw_key3  →  given to your team   (all providers)

  Each key tracks:
  - How many requests made
  - Which provider used
  - Errors and latency

  The real OAuth tokens (from ChatGPT/Gemini login) never leave
  the gateway — they stay encrypted in the database.
```

---

## Cost Comparison

```
  Normal way:
  ┌─────────────────────────────────────┐
  │  OpenAI API Key                     │
  │  Pay per token — every request      │
  │  GPT-4o: ~$2.50 per 1M tokens      │
  └─────────────────────────────────────┘

  This gateway:
  ┌─────────────────────────────────────┐
  │  ChatGPT Pro subscription           │
  │  ~$20/month flat                    │
  │  Unlimited requests via OAuth token │
  └─────────────────────────────────────┘

  Add more accounts → more capacity → still flat cost
```

---

## Summary in One Line

> **We steal the OAuth token that ChatGPT/Gemini's own CLI uses,
> store it in our gateway, and route your API calls through it —
> so the AI thinks it's talking to its own official app.**
