# pi-memless

> Semantic search, persistent memory, and rule-based compression for [Pi](https://shittycodingagent.ai)

[![pi-package](https://img.shields.io/badge/pi--package-compatible-blue)](https://shittycodingagent.ai/packages)
[![npm](https://img.shields.io/npm/v/pi-memless)](https://www.npmjs.com/package/pi-memless)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**pi-memless** adds a local **context and memory engine** to Pi. It runs as a Bun server on port `3434` and exposes 9 tools the LLM can call natively — giving your agent semantic search, cross-session memory, and zero-cost compression.

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

On session start, memless:
1. Starts the Bun server (if not already running)
2. Indexes your project files in the background
3. Injects relevant memories before your first prompt

---

## AGENTS.md

This repo ships an **`AGENTS.md`** file at the root. This file contains mandatory
behavioral rules that are automatically loaded by Pi (and compatible coding agents)
at the start of every session — so the LLM always knows how to use memless correctly
without you having to repeat yourself.

### What it enforces

```
project-root/
└── AGENTS.md   ← auto-loaded by Pi as system-level instructions
```

The `AGENTS.md` defines 6 mandatory rules for the agent:

1. **Always call `memless_recall`** before exploring files on any known task — never open files cold.
2. **Always use `memless_search`** instead of grep/find/glob — fall back to filesystem only on zero results.
3. **Always use `memless_context`** for multi-file analysis — search + recall + compress in one shot.
4. **Immediately store** every significant decision or pattern found with `memless_remember`.
5. **Create a checkpoint** at every milestone and before any risky operation.
6. **Before ending a session**, save all learnings using the `/close-session` prompt template.

It also includes the tool cheat-sheet, server details, compression strategies, memory types,
and prompt template reminders — so the agent always has full context on how to operate memless.

### How to use it in your own project

Copy `AGENTS.md` into your project root. Pi will pick it up automatically.
If you want to customize the rules (e.g. add project-specific conventions), just edit the file —
the agent will follow your additions on the next session.

```bash
# Copy from an installed pi-memless package
cp ~/.pi/packages/pi-memless/AGENTS.md ./AGENTS.md

# Or download directly
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
memless_context({ query: "how does the auth flow work?", maxTokens: 4000 })
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
| `semantic_dedup`      | Repetitive content   | 50–70%    |
| `hierarchical`        | Docs / Markdown      | 60–80%    |

All strategies are deterministic and run entirely locally — no API calls, no cost.

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

---

## Prompt Templates

Four workflow templates are included and registered as Pi prompt commands:

| Template | Command | Use |
|---|---|---|
| Session warm-up | `/session-start` | Recall context and memories at the start of a work session |
| New feature | `/implement` | Structured flow for planning and implementing a new feature |
| Bug hunt | `/debug` | Guided investigation and fix workflow |
| Session close | `/close-session` | Save all learnings and decisions before ending a session |

---

## Commands

```
/memless    — Show server status, embedding provider, cache stats, and full tool list
```

---

## Configuration

All settings are controlled via environment variables before starting Pi:

| Variable             | Default                  | Description                        |
|----------------------|--------------------------|------------------------------------|
| `MEMLESS_PORT`       | `3434`                   | Server port                        |
| `MEMLESS_DATA_DIR`   | `~/.config/memless`      | SQLite data directory              |
| `OLLAMA_URL`         | `http://localhost:11434` | Ollama API URL                     |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text`       | Embedding model to use with Ollama |
| `OPENAI_API_KEY`     | —                        | Use OpenAI embeddings instead      |
| `MISTRAL_API_KEY`    | —                        | Use Mistral embeddings instead     |
| `BUN_PATH`           | auto-detected            | Custom path to `bun` binary        |

---

## Architecture

```
pi-memless/
├── AGENTS.md                     — Mandatory agent rules (copy to your project root)
├── extensions/memless/index.ts   — Pi extension (auto-discovered on install)
├── skills/memless/SKILL.md       — Pi skill with usage rules injected per task
├── prompts/                      — 4 workflow prompt templates
│   ├── session-start.md
│   ├── implement.md
│   ├── debug.md
│   └── close-session.md
└── server/src/
    ├── index.ts       — Bun HTTP server (port 3434)
    ├── config.ts      — Configuration via env vars
    ├── db.ts          — SQLite schema (bun:sqlite)
    ├── embeddings.ts  — Ollama / OpenAI / Mistral / TF-IDF fallback
    ├── compression.ts — Rule-based engine (4 strategies)
    ├── memory.ts      — Store / search / decay / graph relationships
    ├── search.ts      — File indexer + hybrid RRF search
    ├── cache.ts       — L1 in-memory Map + L2 SQLite cache
    ├── checkpoint.ts  — Gzip task snapshots with TTL
    └── jobs.ts        — Background consolidation (5-min cycle)
```

---

## License

MIT — see [LICENSE](./LICENSE)
