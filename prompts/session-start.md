# memless — Session Start (manual warm-up)

> **Normally you don't need this.**
> The extension already runs automatically on every session:
> - `session_start` → server starts + project is indexed (with progress in the status bar)
> - `before_agent_start` → relevant memories are injected before your first substantive prompt
>
> Use this prompt only when:
> - Your first prompt was a short command (e.g. `"ls"`, `"run tests"`) and the auto-recall was skipped
> - You want a deeper architectural warm-up at the start of a complex task
> - The index is stale and you want to force a refresh

---

## Force recall (when auto-recall didn't fire)

```
memless_recall({
  query: "decisions patterns architecture {{focus}}",
  types: ["decision", "pattern", "code"],
  minImportance: 0.4,
  limit: 8
})
```

## Force re-index (when index is stale or missing)

```
memless_index({
  projectPath: "{{projectPath}}",
  projectId:   "{{projectId}}",
  forceReindex: false
})
```

## Deep architectural context (optional — for large or unfamiliar codebases)

```
memless_context({
  query: "overall architecture and main entry points",
  maxTokens: 4000,
  includeMemories: true
})
```
