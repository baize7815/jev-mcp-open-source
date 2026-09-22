# Jev MCP for Cloudflare

English | [中文](README.md)

A self-hosted MCP gateway that runs on Cloudflare Workers and wraps the TypeSafe / Jev System One model as four tools. It is designed for AI assistants that need to make **intent routing, retrieval reranking, and batch semantic judgments** — decisions that call for a structured answer, not long prose. A companion Codex Skill tells the assistant when to call each tool.

- **Backend**: Cloudflare Workers + D1 (SQLite)
- **Upstream model**: TypeSafe System One (`jev-latest`)
- **Transport**: standard Model Context Protocol over JSON-RPC at `/mcp`
- **Admin UI**: built-in `/admin` console to manage API keys and view usage

## Tools

Once deployed, `/mcp` exposes the following four tools. Every call returns a structured answer with confidence — no prose generation. The server validates batch size, enforces concurrency, and isolates per-item failures.

| Tool | Purpose | Typical use |
| --- | --- | --- |
| `route_intent` | Choose among candidate routes / tools / knowledge sources, with confidence | "Tidy that one up" — decide which file, which retrieval path, or whether to answer directly |
| `rerank_candidates` | Score retrieved excerpts by semantic relevance and rank them | A local or knowledge-base search returns 10 results; pick which originals to read |
| `batch_judge` | Apply the same set of questions to many records in one call | Triage tickets, tag documents, filter candidate files |
| `system_one` | Raw pass-through to TypeSafe System One with custom state and questions | Custom boolean / choice / scoring judgments not covered by the tools above |

Universal limits: at most **10** records per batch, **128 KB** total input, server-side concurrency **3**. Failed items in a batch are marked `failed` — they mean "not judged", not "irrelevant". Failed calls are never retried automatically to avoid double billing.

## How it works

```
AI assistant (Codex / MCP client)
        │  JSON-RPC over HTTP
        ▼
Cloudflare Worker  ──►  D1: encrypted TypeSafe API keys (AES-GCM)
        │
        │  Authorization: Bearer <rotating key>
        ▼
https://api.typesafe.ai/v1/systemone   (model: jev-latest)
```

- TypeSafe API keys live only in the server-side D1 database, encrypted with `KEY_ENCRYPTION_SECRET` (AES-GCM). The database holds ciphertext and a last-four hint only.
- Enabled keys are selected by a rotating cursor; each call's result (success/failure, token usage) is written back to D1.
- `/mcp` is intentionally **unauthenticated** — anyone who knows the deployment URL can spend your TypeSafe quota. Only `/admin` requires `ADMIN_TOKEN`. Treat the worker URL as semi-public, or add access control on the Cloudflare side.

## Prerequisites

- Node.js **24.11+** and npm
- A Cloudflare account
- At least one TypeSafe API key (obtain from the TypeSafe console)

## Deploy

1. Install dependencies and copy the config template:

   ```powershell
   npm ci
   Copy-Item wrangler.example.jsonc wrangler.jsonc
   ```

   On macOS / Linux use `cp wrangler.example.jsonc wrangler.jsonc`.

2. Log in to Cloudflare and create a D1 database:

   ```sh
   npx wrangler login
   npx wrangler d1 create jev-mcp
   ```

   Copy the `database_id` from the output into local `wrangler.jsonc`, replacing the all-zero placeholder. Multi-account users also set their own `account_id` there.

3. Initialize the remote database:

   ```sh
   npx wrangler d1 migrations apply jev-mcp --remote
   ```

4. Set two Worker secrets (you will be prompted interactively — never put the values in source files or command-line arguments):

   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put KEY_ENCRYPTION_SECRET
   ```

   - `ADMIN_TOKEN`: a management password of your choice.
   - `KEY_ENCRYPTION_SECRET`: **64 hex characters (32 bytes)**, generated with a password manager or `openssl rand -hex 32`. It encrypts the API keys stored in D1; losing or rotating it makes existing keys undecryptable — back it up.

5. Check and deploy:

   ```sh
   npm run types
   npm run typecheck
   npm test
   npm run deploy:check
   npm run deploy
   ```

6. Open the worker URL printed by Wrangler at `/admin`, log in with `ADMIN_TOKEN`, and add your TypeSafe API key. Then point your MCP client at the same worker URL's `/mcp`.

## Calling the tools

### `route_intent`

```json
{
  "request": "Find the lighting tutorial I saved earlier",
  "context": "The user has a knowledge base of photography tutorials and wants to retrieve one from saved materials.",
  "min_confidence": 0.65
}
```

When `routes` is omitted, six built-in paths are used: `answer`, `search_files`, `search_knowledge`, `search_web`, `implement`, `review`. You can also pass your own candidates:

```json
{
  "request": "Handle that one",
  "context": "There are two different reports on the desk; the user did not say which.",
  "routes": [
    { "id": "report_a", "description": "Process report A" },
    { "id": "report_b", "description": "Process report B" }
  ]
}
```

When `status` is `resolved`, the chosen `route` and `confidence` are returned. If confidence is below `min_confidence` or no route fits, the response is `needs_review` with an `__uncertain__` hint.

### `rerank_candidates`

```json
{
  "query": "How do I attach a custom domain to a Cloudflare Worker?",
  "top_k": 3,
  "candidates": [
    { "id": "pasta", "text": "Boil pasta for eight minutes with tomato sauce and basil." },
    { "id": "domain", "text": "In the Worker's Settings → Domains & Routes, add a Custom Domain……" },
    { "id": "lighting", "text": "Place a softbox at the front-left of the subject for portrait lighting……" }
  ]
}
```

Returns a `ranked` list scored 0–1 by relevance. Candidates that fail to score go to `failed` — meaning "not judged", not "irrelevant". Pass actual excerpts in `text`, not just filenames.

### `batch_judge`

```json
{
  "items": [
    { "id": "billing", "state": "I was charged twice. Please refund the duplicate payment." },
    { "id": "bug",     "state": "The app crashes every time I open settings." }
  ],
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Which team should handle this report?",
      "criteria": { "billing": "Payments and refunds", "technical": "Software bugs and crashes" }
    },
    "refund": {
      "type": "noul",
      "instructions": "Does the user ask for a refund?"
    }
  }
}
```

Question types:

- `noul`: whether a condition holds. Returns `{ noul: 0..1, confidence }`.
- `choice`: pick one of 2–255 named options. Returns `{ choice, confidence, probabilities }`.
- `score`: score on 2–10 ordered levels. Returns `{ score: 0..n-1, confidence }`.

### `system_one`

For custom judgments beyond the three tools above, pass `state` and `questions` directly:

```json
{
  "state": "The parcel has been delivered.",
  "questions": {
    "delivered": { "type": "noul", "instructions": "Has the parcel been delivered?" }
  }
}
```

## Admin console

Open `/admin` and log in with `ADMIN_TOKEN` to:

- Add, disable, or delete TypeSafe API keys (label + last-four hint).
- View per-key call count, error count, and input/output token usage.
- Enabled keys are rotated server-side by a cursor; a failed call is not retried against the next key.

The admin API compares the token with a constant-time SHA-256 check, the console page ships with a strict CSP, and the token lives only in browser memory.

## Companion Codex Skill

Copy the entire `skills/jev-workflows/` directory into your Codex personal skills folder (typically `~/.codex/skills/`), connect your deployed MCP, and refresh the tool list.

The Skill calls Jev proactively at three decision points rather than intercepting every message:

1. When intent is ambiguous, depends on prior context, or needs a choice among tools / knowledge sources.
2. After file or knowledge-base retrieval returns multiple candidates that need relevance ranking before reading originals.
3. When the same set of questions must be applied to many records for classification or filtering.

If your MCP client only cached the legacy `system_one`, use the bundled fallback script:

```powershell
$env:JEV_MCP_URL = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp'
node skills/jev-workflows/scripts/call-mcp.mjs --describe
node skills/jev-workflows/scripts/call-mcp.mjs rerank_candidates --input candidates.json
```

The script has no built-in remote URL; without `JEV_MCP_URL` set it refuses to make network calls. It does not read Cloudflare login files or local API keys.

## Local development

Put test secrets in the git-ignored `.dev.vars`, then:

```sh
npx wrangler d1 migrations apply jev-mcp --local
npm run dev -- --local --port 8791
node scripts/verify.mjs http://127.0.0.1:8791
```

Without `--live`, the script only checks the tool list, admin static assets, and input validation. Add `--live` against your own deployment to run a few real inferences and spend your own TypeSafe quota:

```sh
node scripts/verify.mjs https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev --live
```

## Limits

- At most 10 records per batch, 128 KB total input, server-side concurrency 3.
- Failed requests are not retried; `usage_complete: false` means the summary does not cover potential spend on failed items.
- The intent confidence threshold (default 0.65) is a heuristic review line, not a correctness guarantee or user authorization.
- Scores and route suggestions are relative signals; the assistant should still read the originals before answering.

## Security notes

Run `npm run privacy:check` before publishing or pushing. It checks tracked files for private configuration, common credential formats and hardcoded MCP endpoints in scripts, reporting only filenames and categories. This heuristic does not guarantee detection of every secret or scan commit history. Revoke or rotate any previously exposed credential; deleting the current file does not undo exposure.

- The repository ships source and config templates only. Real `wrangler.jsonc`, `.dev.vars`, `.env*`, `*.pem`, `*.key` and similar files are excluded by `.gitignore`.
- `/mcp` is unauthenticated by default; anyone with the deployment URL can spend your TypeSafe quota. Add access control on the Cloudflare side if you do not want it public.
- `ADMIN_TOKEN` and `KEY_ENCRYPTION_SECRET` are injected via Wrangler secrets — never commit them to source, config files, or command-line arguments.

---

Copyright © 2026 **baize7815**. Original code and Skill in this project are licensed under the [MIT License](https://github.com/baize7815/jev-mcp-open-source/blob/main/LICENSE); dependencies and references are listed in the [third-party notices](https://github.com/baize7815/jev-mcp-open-source/blob/main/THIRD_PARTY_NOTICES.md).
