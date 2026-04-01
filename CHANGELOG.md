# Changelog

All notable changes to `pi-memless` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [SemVer](https://semver.org/)

---

## [1.0.0] — 2026-03-31

### Added
- **memless_search** — Hybrid semantic + keyword search (vector + FTS5 + RRF fusion)
- **memless_remember** — Persistent cross-session memory with 5 typed categories
- **memless_recall** — Semantic retrieval of past decisions, patterns, and code insights
- **memless_compress** — Rule-based compression (no LLM): 4 strategies, up to 98% reduction
- **memless_context** — One-shot: search + memories + compress in a single call
- **memless_checkpoint** — Gzip-compressed task snapshots with TTL (3d manual / 14d milestone)
- **memless_index** / **memless_index_status** — Async project indexing with staleness detection
- **memless_analytics** — Cache performance and usage metrics
- **Auto-start** — Server spawns automatically on `session_start`
- **Auto-recall** — Injects relevant memories before the first prompt of each session
- **Auto-compaction** — Hooks `session_before_compact` to compress via rule engine (no LLM cost)
- **Auto-shutdown** — Saves session note on `session_shutdown`
- **Embedding auto-detect** — Ollama → OpenAI → Mistral → TF-IDF (offline fallback)
- **Background jobs** — Memory decay, promotion, pruning, redundancy filter (5-min cycle)
- **L1/L2 cache** — In-process Map + SQLite with configurable TTL
- **Knowledge graph** — Auto-links similar memories via cosine similarity
- **`/memless` command** — Status, server health, tool list
