# Wrapper Project — Agent Instructions

## memless Context Engine

This workspace uses **memless** — a local semantic search, compression, and
persistent memory engine that runs as a Bun server on port **3434**.

### Mandatory rules (apply to every task)

1. **Always call `memless_recall`** before exploring files on any known task.
   Do not open files with Read before checking what is already remembered.

2. **Always use `memless_search`** instead of grep, find, or glob for code exploration.
   Fall back to Read/Bash only when memless returns zero results.

3. **Always use `memless_context`** when you need multiple files or memories
   in a single call — it search + recalls + compresses in one step.

4. **Immediately store** every significant decision, pattern, or architectural
   insight you discover, using `memless_remember`. Do not wait to be asked.

5. **Create a checkpoint** at every milestone and before any risky operation
   (deleting files, large refactors, migrations).

6. **Before ending a session**, save learnings with `memless_remember` using
   the `/close-session` prompt template.

### Tool cheat-sheet

| Goal                            | Tool                  |
|---------------------------------|-----------------------|
| Recall past context             | `memless_recall`      |
| Find code by meaning            | `memless_search`      |
| Multi-file + memories at once   | `memless_context`     |
| Save a decision / pattern       | `memless_remember`    |
| Compress a large code block     | `memless_compress`    |
| Save task state / milestone     | `memless_checkpoint`  |
| View usage metrics              | `memless_analytics`   |
| Re-index project                | `memless_index`       |

### Server

- **Port**: 3434
- **Start**: `cd memless && bun src/index.ts`
- **Health**: `curl http://localhost:3434/health`
- **Data dir**: `~/.config/memless/memless.db` (SQLite)
- **Embeddings**: Ollama `nomic-embed-text` (auto-detected; falls back to TF-IDF if Ollama is offline)

### Compression strategies (no LLM cost)

| Strategy              | Use for              | Reduction |
|-----------------------|----------------------|-----------|
| `code_structure`      | Source code          | 70–90%    |
| `conversation_summary`| Chat / logs          | 80–95%    |
| `semantic_dedup`      | Repetitive content   | 50–70%    |
| `hierarchical`        | Docs / markdown      | 60–80%    |

### Memory types and decay rates

| Type           | Decay rate | Notes                          |
|----------------|-----------|--------------------------------|
| `decision`     | 0.97      | Architectural choices — slow   |
| `pattern`      | 0.94      | Recurring code patterns        |
| `code`         | 0.90      | Important snippets             |
| `preference`   | 0.88      | User / team preferences        |
| `conversation` | 0.78      | Session notes — decays fast    |

Memories with `importance < 0.25` + age > 45 days + access < 2 are auto-pruned.
Memories with `importance ≥ 0.85` + `accessCount ≥ 3` are auto-promoted to `persistent`.

### Prompt templates

Use `/session-start` at the beginning of a new work session.
Use `/implement` when starting a new feature.
Use `/debug` when investigating a bug.
Use `/close-session` before ending a session to save learnings.
