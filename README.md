# pi-memless

> Semantic search, persistent memory, and rule-based compression for [Pi](https://shittycodingagent.ai)

[![pi-package](https://img.shields.io/badge/pi--package-compatible-blue)](https://shittycodingagent.ai/packages)
[![npm](https://img.shields.io/npm/v/pi-memless)](https://www.npmjs.com/package/pi-memless)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**pi-memless** adds a local **context and memory engine** to Pi. It runs as a Bun server on port `3434` and exposes tools the LLM can call natively — giving your agent semantic search, cross-session memory, zero-cost compression, and a browser dashboard.

| What                      | How much                      |
|---------------------------|-------------------------------|
| Token reduction (code)    | 70–90% (rule-based, no LLM)   |
| Token reduction (chat)    | 80–95% (rule-based, no LLM)   |
| Search quality            | Vector + FTS5 + RRF           |
| Memory persistence        | SQLite, cross-session         |
| Cost of compression       | $0 — no LLM call              |
| Ollama required?          | No — TF-IDF fallback built-in |

---

## Inspiration

This project was inspired by **[th0th](https://github.com/S1LV4/th0th)** by [@S1LV4](https://github.com/S1LV4) — a memory and context layer for coding agents. pi-memless takes those ideas and builds on top of them: adding rule-based compression, hybrid search with RRF ranking, background jobs, checkpoints, and native Pi integration as a package/extension/skill.

---

## Install

```bash
pi install npm:pi-memless
```

Or directly from source:

```bash
pi install git:github.com/worxtation/pi-memless
```

**Requirements:**
- [Bun](https://bun.sh) ≥ 1.0 — the server runs via `bun src/index.ts`
- (Optional) [Ollama](https://ollama.ai) with `nomic-embed-text` for real semantic embeddings
  - Falls back to TF-IDF automatically when Ollama is offline

---

## Quickstart

```bash
# 1. Install
pi install npm:pi-memless

# 2. (Optional) Start Ollama for semantic embeddings
ollama pull nomic-embed-text

# 3. Open Pi in your project — memless starts automatically
pi
```

Everything below happens **automatically** on every session — no setup needed:

| Step | Hook | What happens |
|------|------|--------------|
| Server starts | `session_start` | Bun server spawned (or reuses existing) |
| Project indexed | `session_start` | Files indexed in background; status bar shows `indexing 12/87 (14%)` → `● ready` |
| Memories injected | `before_agent_start` | Relevant past decisions recalled and prepended to your first prompt |
| Stale index warning | `tool_call` | Warns before a search if the index is >24 hours old |
| Context compressed | `session_before_compact` | Conversation compressed without LLM when Pi hits context limit |
| Decisions extracted | `session_before_compact` | Key decisions auto-saved to memory during each compaction |
| Session saved | `session_shutdown` | Session note saved (only when ≥3 tool calls were made) |

---

## AGENTS.md

This repo ships an **`AGENTS.md`** file at the root. Pi (and compatible coding agents) load it
automatically at the start of every session — so the LLM always knows how to use memless correctly.

### What it enforces

1. **Always call `memless_recall`** before exploring files on any known task — never open files cold.
2. **Always use `memless_search`** instead of grep/find/glob — fall back to filesystem only on zero results.
3. **Always use `memless_context`** for multi-file analysis — search + recall + compress in one shot.
4. **Immediately store** every significant decision or pattern found with `memless_remember`.
5. **Create a checkpoint** at every milestone and before any risky operation.
6. **Before ending a session**, save all learnings using the `/close-session` prompt template.

### How to use it in your own project

Copy `AGENTS.md` into your project root:

```bash
cp ~/.pi/packages/pi-memless/AGENTS.md ./AGENTS.md
# or
curl -O https://raw.githubusercontent.com/worxtation/pi-memless/main/AGENTS.md
```

---

## Tools

| Tool | Description |
|------|-------------|
| `memless_index` | Index project files (async, returns jobId) |
| `memless_index_status` | Poll indexing progress |
| `memless_search` | Hybrid semantic + keyword search (Vector + FTS5 + RRF) |
| `memless_remember` | Store a decision / pattern / code snippet / preference |
| `memless_recall` | Retrieve memories from previous sessions |
| `memless_forget` | Delete a wrong or outdated memory by ID |
| `memless_compress` | Rule-based compression — zero LLM cost |
| `memless_context` | Search + memories + compress in one single call |
| `memless_checkpoint` | Gzip task snapshot with TTL |
| `memless_analytics` | Cache and usage metrics |

---

## Usage Patterns

### Start of every task
```
memless_recall({ query: "decisions and patterns for <area>", types: ["decision","pattern"] })
```

### Explore code (replaces grep/find)
```
memless_search({ query: "JWT authentication middleware", maxResults: 8 })
```

### Multi-file analysis in one shot
```
memless_context({
  query: "how does the auth flow work?",
  maxTokens: 4000,
  responseMode: "summary"   // or "full" for complete file sections
})
```

### Save a discovery
```
memless_remember({
  content: "Using Drizzle ORM — schema in src/db/schema.ts",
  type: "decision",
  importance: 0.85,
  tags: ["database"]
})
```

### Delete a wrong memory
```
memless_forget({ memoryId: "mem_1712345678_abc123" })
```

### Compress before sending large code
```
memless_compress({ content: "<paste code>", strategy: "code_structure" })
```

### Milestone checkpoint
```
memless_checkpoint({
  taskId: "feat-auth",
  description: "Refactoring auth",
  progressPercent: 60,
  type: "milestone"
})
```

---

## Compression Strategies (no LLM)

| Strategy              | Use for              | Reduction |
|-----------------------|----------------------|-----------|
| `code_structure`      | Source code          | 70–90%    |
| `conversation_summary`| Chat / log history   | 80–95%    |
| `line_dedup`          | Repetitive content   | 30–50%    |
| `hierarchical`        | Docs / Markdown      | 60–80%    |

All strategies are deterministic and run entirely locally — no API calls, no cost.

> **Note:** `memless_compress` skips the server round-trip entirely for content under ~200 tokens.

---

## Memory Types & Decay

Memories are stored in SQLite and decay over time based on their type.
The more a memory is accessed, the slower it decays.

| Type           | Decay / 7 days | Notes                           |
|----------------|---------------|---------------------------------|
| `decision`     | 0.97          | Architectural choices — slowest |
| `pattern`      | 0.94          | Recurring code patterns         |
| `code`         | 0.90          | Key snippets / APIs             |
| `preference`   | 0.88          | User / team preferences         |
| `conversation` | 0.78          | Session notes — decays fastest  |

**Auto-promotion:** `importance ≥ 0.85` + `accessCount ≥ 3` → promoted to `persistent` (no decay)  
**Auto-pruning:** `importance < 0.25` + age > 45 days + `accessCount < 2` → deleted automatically  
**Deduplication:** storing a memory similar to an existing one reinforces the existing memory instead of creating a duplicate

---

## Dashboard

Open **`http://localhost:3434`** in your browser for a live dashboard:

- **Status** — server uptime, embedding provider, cache L1/L2 sizes
- **Memories** — paginated list with type, importance, content preview; inline delete button
- **Searches** — top queries and average latency
- **Index jobs** — progress and file/chunk counts

The dashboard auto-refreshes every 5 seconds. Memories can be edited or deleted directly in the browser — no LLM required.

---

## Indexing & .gitignore

The indexer respects `.gitignore` files at every directory level. Patterns like `dist/`, `generated/`, custom glob rules, and negations (`!important.ts`) are all honoured — only source files get indexed.

Directories in the built-in skip list (`node_modules`, `.git`, `dist`, `build`, `.next`, `target`, etc.) are always skipped regardless of `.gitignore`.

---

## Prompt Templates

| Template | Command | Use |
|---|---|---|
| Session warm-up | `/session-start` | Manual override — force recall/index when auto-recall didn't fire |
| New feature | `/implement` | Structured flow for planning and implementing a new feature |
| Bug hunt | `/debug` | Guided investigation and fix workflow |
| Session close | `/close-session` | Save all learnings and decisions before ending a session |

> **`/session-start` is rarely needed** — the extension auto-recalls memories and auto-indexes on every session start. Use it only when your first prompt was a short command (e.g. `ls`) that bypassed the auto-recall, or when you want a forced deep warm-up.

---

## Commands

```
/memless    — Show server status, embedding provider, cache stats, tool list, and dashboard link
```

---

## Configuration

| Variable             | Default                  | Description                                   |
|----------------------|--------------------------|-----------------------------------------------|
| `MEMLESS_PORT`       | `3434`                   | Server port                                   |
| `MEMLESS_DATA_DIR`   | `~/.config/memless`      | SQLite data directory                         |
| `MEMLESS_LOG`        | `error`                  | Log level: `silent` / `error` / `info` / `debug` |
| `OLLAMA_URL`         | `http://localhost:11434` | Ollama API URL                                |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text`       | Embedding model to use with Ollama            |
| `OPENAI_API_KEY`     | —                        | Use OpenAI embeddings instead                 |
| `MISTRAL_API_KEY`    | —                        | Use Mistral embeddings instead                |
| `BUN_PATH`           | auto-detected            | Custom path to `bun` binary                   |

By default the server logs only startup errors. Set `MEMLESS_LOG=info` to see indexing progress, background jobs, and embedding provider detection.

---

## Architecture

```
pi-memless/
├── AGENTS.md                     — Mandatory agent rules (copy to your project root)
├── extensions/memless/index.ts   — Pi extension (auto-discovered on install)
├── skills/memless/SKILL.md       — Pi skill with usage rules injected per task
├── prompts/                      — Workflow prompt templates
│   ├── session-start.md          — Manual warm-up override (rarely needed)
│   ├── implement.md
│   ├── debug.md
│   └── close-session.md
└── server/src/
    ├── index.ts        — Bun HTTP server (port 3434)
    ├── config.ts       — Configuration via env vars
    ├── db.ts           — SQLite schema (bun:sqlite)
    ├── embeddings.ts   — Ollama / OpenAI / Mistral / TF-IDF fallback
    ├── compression.ts  — Rule-based engine (4 strategies)
    ├── memory.ts       — Store / search / decay / dedup / graph relationships
    ├── search.ts       — File indexer + hybrid RRF search + .gitignore support
    ├── cache.ts        — L1 in-memory Map + L2 SQLite cache
    ├── checkpoint.ts   — Gzip task snapshots with TTL
    ├── jobs.ts         — Background consolidation (5-min cycle)
    ├── dashboard.ts    — Browser dashboard HTML (served at GET /)
    └── logger.ts       — Log level via MEMLESS_LOG env var
```

---

## License

MIT — see [LICENSE](./LICENSE)
