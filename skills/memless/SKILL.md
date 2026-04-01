---
name: memless
description: >
  Mandatory rules for using memless — the semantic search, compression, and
  persistent memory engine built into this Pi workspace. Activates on tasks
  involving code search, architecture exploration, context compression, storing
  decisions, or recovering knowledge from previous sessions.
license: MIT
metadata:
  author: wrapper-project
  version: "1.0.0"
---

# memless Skill

memless is always running when Pi is active in this project. These rules govern
how and when to call each tool to maximise token efficiency and cross-session
continuity.

---

## Tool Priority (always follow this order)

| Priority | Tool                  | When to use |
|----------|-----------------------|-------------|
| 1        | `memless_recall`      | Start of EVERY task — recover decisions & patterns |
| 2        | `memless_search`      | Explore code — replace grep/find/glob/Read |
| 3        | `memless_context`     | When multiple files or memories needed at once |
| 4        | `memless_remember`    | After finding patterns, decisions, or insights |
| 5        | `memless_compress`    | When a code block > 2 000 tokens must be sent |
| 6        | `memless_checkpoint`  | At every milestone or before risky operations |
| 7        | `memless_analytics`   | When asked about performance or token usage |
| 8        | `memless_index`       | Explicitly re-index or when index is stale |
| 9        | grep / Read / Bash    | **Only** when memless returns no result |

---

## Decision Flow

```
Starting a new task?
  → memless_recall(query="relevant past decisions for this area")
  → memless_search(query="…") OR memless_context(query="…")

Found something important?
  → memless_remember(type="decision"|"pattern"|"code", importance≥0.7)

Context window getting large?
  → memless_compress(strategy="code_structure")  ← no LLM cost

Finishing a milestone / risky operation?
  → memless_checkpoint(taskId, description, type="milestone")

Need a wide view (code + memories combined)?
  → memless_context(query, maxTokens=4000)

Need raw file content after search?
  → Use filePath + lineStart from search results → Read(path, offset, limit)
```

---

## Tool Reference

### memless_recall — session-start / task-start
```
memless_recall({
  query: "authentication decisions and patterns",
  types: ["decision", "pattern"],
  minImportance: 0.4,
  limit: 8
})
```
Always call this **before** exploring files on a known project.

---

### memless_search — code exploration
```
memless_search({
  query: "JWT middleware authentication handler",
  maxResults: 8,
  minScore: 0.2,
  responseMode: "summary",          // "full" for complete content
  exclude: ["**/*.test.*", "dist/**"]
})
```
Returns `filePath`, `lineStart`, `lineEnd`, `score`, and a `preview`.
Use `responseMode: "full"` only when you need the complete code block.

---

### memless_context — single-call context bundle
```
memless_context({
  query: "how does authentication work end to end?",
  maxTokens: 4000,
  maxResults: 5,
  includeMemories: true,
  memoryBudgetRatio: 0.2   // 20% for memories, 80% for code
})
```
Use this instead of calling search + recall separately. Activates session cache
— repeated calls with the same query cost ~8 tokens instead of full content.

---

### memless_remember — persist knowledge
```
memless_remember({
  content: "Using Drizzle ORM with PostgreSQL — schema in src/db/schema.ts",
  type: "decision",
  importance: 0.85,
  tags: ["database", "orm", "architecture"]
})
```
Memory types:
- `decision`    → architecture choices, trade-offs  (decay: 0.97 — very slow)
- `pattern`     → recurring code patterns           (decay: 0.94)
- `code`        → important snippets or APIs        (decay: 0.90)
- `preference`  → user/team preferences             (decay: 0.88)
- `conversation`→ key conversation points           (decay: 0.78 — fastest)

---

### memless_compress — token reduction without LLM
```
memless_compress({
  content: "<large code block>",
  strategy: "code_structure"   // keeps signatures, removes bodies
})
```

| Strategy              | Best for            | Reduction  |
|-----------------------|---------------------|------------|
| `code_structure`      | Source code         | 70–90 %    |
| `conversation_summary`| Chat history        | 80–95 %    |
| `semantic_dedup`      | Repetitive content  | 50–70 %    |
| `hierarchical`        | Structured docs     | 60–80 %    |

---

### memless_checkpoint — save task state
```
memless_checkpoint({
  taskId: "feat-auth-refactor",
  description: "Refactoring JWT authentication middleware",
  progressPercent: 60,
  currentStep: "updating token validation",
  type: "milestone",
  decisions: ["Using RS256 instead of HS256 for multi-service support"],
  fileChanges: ["src/middleware/auth.ts", "src/utils/jwt.ts"],
  nextAction: "update integration tests"
})
```
`type: "milestone"` → TTL 14 days  
`type: "manual"`    → TTL 3 days

---

## System-Prompt Rule (add to CLAUDE.md / AGENTS.md)

```
Always call memless_recall before exploring this project's files.
Prefer memless_search over grep/find. Use memless_context for multi-file analysis.
When you identify a decision, pattern, or architectural insight, store it with
memless_remember immediately — do not wait to be asked.
```
