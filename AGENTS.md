# AGENTS.md
> Shared context for all AI coding assistants — Claude Code, Codex, Cursor, Gemini CLI, etc.
> This file is symlinked as CLAUDE.md. One source of truth.

---

## MANDATORY: How Every AI Session Must Work

These rules exist so that switching between Claude, Codex, Cursor, or any other tool mid-feature
causes zero context loss. The **Lark Wiki** is the source of truth for all plans and progress.

### Lark Wiki — Source of Truth

All project documentation lives in the **Lark Wiki** under `Tech Hub > 02 — Internal Projects > Gateway`.
Use `lark-cli` to read and write wiki pages. Do NOT maintain separate local markdown files for plans
or progress — the wiki is canonical.

**Wiki structure:**
```
Gateway
├── Overview
├── Architecture & Tech Stack
├── URLs & Access
├── Reviews & MoMs
├── Updates
└── References
    └── OpenAI Codex Workaround
```

**Wiki space ID:** `7635896570625396443`
**Project node token:** `OcTkwnI53iKtFIkxN8Uld9J2gje`

**Wiki page tokens (for lark-cli):**

| Page | node_token | obj_token |
|---|---|---|
| Gateway (root) | `OcTkwnI53iKtFIkxN8Uld9J2gje` | `SCT4dnAXdoGqWFx1Gaclxiv9g1f` |
| Overview | `DyVlwheaOiH39FkQYykljyTVgwe` | `IyDVduF5xoS716xCG6UlshK7gIe` |
| Architecture & Tech Stack | `Laf5wgxt5iBVjfkLsLtl4NTWgOb` | `Vd2Xdi7nboOLVax5GcrlsopXgRh` |
| URLs & Access | `PQFQwfTJ9ilkpLklCCOl1gpMgbg` | `EV3bddPkyoQiCXxA1bOlbDZqgVb` |
| Reviews & MoMs | `SdsNwDNTZi8LwBkAvQ5lL8rjgG6` | `KAfGd7YhUopAHYxQ457lNcAUgnQ` |
| Updates | `WOe6wtYmei9W9QkZVBTlUDXKgBe` | `M0XAdFjtsoiMhpxqwJ5lSf00gdb` |
| References | `LggywvoiPiTuxikp72hlyTVYgEf` | `RWOydf9xTo8NFqxTxaKlym58gMh` |
| OpenAI Codex Workaround | `TApqwQYcqimIA8kKYiRlYeDOgYy` | `TREfdrwGnoxjc7xntVClVdNig6b` |

### How to read/write wiki pages

```bash
# Read a page
lark-cli docs +fetch --api-version v2 --doc <obj_token> --doc-format markdown

# Overwrite a page
lark-cli docs +update --api-version v2 --doc <obj_token> --command overwrite --doc-format markdown --content @.context/file.md

# Append to a page
lark-cli docs +update --api-version v2 --doc <obj_token> --command append --doc-format markdown --content "content"

# Create a new sub-page
lark-cli wiki +node-create --space-id 7635896570625396443 --parent-node-token <PARENT_NODE> --title "Title"
```

### At the START of every session
1. Fetch the **Updates** page (`obj_token: M0XAdFjtsoiMhpxqwJ5lSf00gdb`) and read the latest week's entry
2. Fetch the **Overview** page (`obj_token: IyDVduF5xoS716xCG6UlshK7gIe`) for provider status and pending actions
3. If the request doesn't match any existing context, ask before writing code

### During a session
- Architecture decisions go to the **Architecture & Tech Stack** page
- Blockers go to the **Updates** page immediately

### At the END of every session (before stopping)
1. Overwrite the **Updates** page with a fresh snapshot (new week entry at top, keep all prior entries)
2. Update **Overview** provider status table if any integration status changed
3. Push via `lark-cli docs +update`

**This is not optional.** Treat updating the wiki as the last action in every session.

---

## Project: Gateway

A unified LLM proxy that routes requests to OpenAI, Gemini, and Claude from a single OpenAI-compatible endpoint. Auto-detects provider from model name prefix.

**Stack:** Node 20 + TypeScript + Express (server), React 18 + Vite (client), Postgres, pnpm workspaces.

**Key entry points:**
- `server/src/routes/proxy.ts` — main `/v1/chat/completions` proxy
- `server/src/loadbalancer/` — account selection (LRU + jitter, retry, cooldowns)
- `server/src/oauth/` — per-provider OAuth adapters

**Provider status (as of 07 May 2026):**
- OpenAI — Working (aliases added, allowlist removed)
- Gemini — Working (OAuth fixed, aliases added, pro model gating)
- Claude — In progress
