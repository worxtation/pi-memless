# pi-memless

> Semantic search, persistent memory, and rule-based compression for [Pi](https://shittycodingagent.ai)

[![pi-package](https://img.shields.io/badge/pi--package-compatible-blue)](https://shittycodingagent.ai/packages)
[![npm](https://img.shields.io/npm/v/pi-memless)](https://www.npmjs.com/package/pi-memless)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

memless adds a local **context and memory engine** to Pi. It runs as a Bun server (port 3434) and exposes 9 tools the LLM can call natively:

| What                      | How much                  |
|---------------------------|---------------------------|
| Token reduction (code)    | 70–90% (rule-based)       |
| Token reduction (chat)    | 80–95% (rule-based)       |
| Search quality            | Vector + FTS5 + RRF       |
| Memory persistence        | SQLite, cross-session     |
| Cost of compression       | $0 — no LLM call          |
| Ollama required?          | No — TF-IDF fallback built-in |

---

## Install

```bash
pi install npm:pi-memless
```

Or from source:

```bash
pi install git:github.com/YOUR_USER/pi-memless
```

**Requirements:**
- [Bun](https://bun.sh) ≥ 1.0 — the server runs via `bun src/index.ts`
- (Optional) [Ollama](https://ollama.ai) with `nomic-embed-text` for real semantic search
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
1. Starts the server (if not already running)
2. Indexes your project in the background
3. Injects relevant memories before your first prompt

---

## Tools

| Tool | Description |
|------|-------------|
| `memless_index` | Index project (async, returns jobId) |
| `memless_index_status` | Poll indexing progress |
| `memless_search` | Hybrid semantic + keyword search |
| `memless_remember` | Store decision / pattern / code / preference |
| `memless_recall` | Retrieve memories from previous sessions |
| `memless_compress` | Rule-based compression — no LLM, no cost |
| `memless_context` | Search + memories + compress in one call |
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
memless_remember({ content: "Using Drizzle ORM — schema in src/db/schema.ts", type: "decision", importance: 0.85, tags: ["database"] })
```

### Compress before sending large code
```
memless_compress({ content: "<paste code>", strategy: "code_structure" })
```

### Milestone checkpoint
```
memless_checkpoint({ taskId: "feat-auth", description: "Refactoring auth", progressPercent: 60, type: "milestone" })
```

---

## Compression Strategies (no LLM)

| Strategy              | Use for              | Reduction |
|-----------------------|----------------------|-----------|
| `code_structure`      | Source code          | 70–90%    |
| `conversation_summary`| Chat / log history   | 80–95%    |
| `semantic_dedup`      | Repetitive content   | 50–70%    |
| `hierarchical`        | Docs / Markdown      | 60–80%    |

---

## Memory Types & Decay

| Type           | Decay / 7 days | Notes                           |
|----------------|---------------|---------------------------------|
| `decision`     | 0.97          | Architectural choices — slowest |
| `pattern`      | 0.94          | Recurring code patterns         |
| `code`         | 0.90          | Key snippets / APIs             |
| `preference`   | 0.88          | User / team preferences         |
| `conversation` | 0.78          | Session notes — decays fastest  |

**Auto-promotion**: `importance ≥ 0.85` + `accessCount ≥ 3` → `persistent`  
**Auto-pruning**: `importance < 0.25` + age > 45 days + `accessCount < 2` → deleted

---

## Commands

```
/memless    — Show server status, provider, cache stats, and tool list
```

---

## Prompt Templates

| Template | Use |
|---|---|
| `/session-start` | Warm up context at the start of a work session |
| `/implement` | Structured flow for adding a new feature |
| `/debug` | Investigate and fix a bug |
| `/close-session` | Save all learnings before ending a session |

---

## Configuration

Set via environment variables before starting Pi:

| Variable             | Default                  | Description               |
|----------------------|--------------------------|---------------------------|
| `MEMLESS_PORT`       | `3434`                   | Server port               |
| `MEMLESS_DATA_DIR`   | `~/.config/memless`      | SQLite data directory     |
| `OLLAMA_URL`         | `http://localhost:11434` | Ollama API URL            |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text`       | Embedding model           |
| `OPENAI_API_KEY`     | —                        | Use OpenAI for embeddings |
| `MISTRAL_API_KEY`    | —                        | Use Mistral for embeddings|
| `BUN_PATH`           | auto-detected            | Custom path to `bun`      |

---

## Architecture

```
pi-memless/
├── extensions/memless/index.ts  — Pi extension (auto-discovered)
├── skills/memless/SKILL.md       — Pi skill with usage rules
├── prompts/                      — 4 workflow templates
└── server/src/
    ├── index.ts       — Bun HTTP server (port 3434)
    ├── config.ts      — Configuration
    ├── db.ts          — SQLite schema (bun:sqlite)
    ├── embeddings.ts  — Ollama / OpenAI / Mistral / TF-IDF
    ├── compression.ts — Rule-based engine (4 strategies)
    ├── memory.ts      — Store / search / decay / graph
    ├── search.ts      — Index files + hybrid RRF search
    ├── cache.ts       — L1 Map + L2 SQLite cache
    ├── checkpoint.ts  — Gzip task snapshots
    └── jobs.ts        — Background consolidation (5-min cycle)
```

---

## License

MIT
