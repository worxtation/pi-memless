# memless — Session Start

Call `memless_recall` with the query below to warm up context from previous sessions,
then index the project if the index is missing or stale.

```
memless_recall({
  query: "decisions patterns architecture {{focus}}",
  types: ["decision", "pattern", "code"],
  minImportance: 0.4,
  limit: 8
})
```

After recall, index if needed:

```
memless_index({
  projectPath: "{{projectPath}}",
  projectId:   "{{projectId}}",
  forceReindex: false
})
```

Then explore with:
```
memless_context({
  query: "overall architecture and main entry points",
  maxTokens: 4000,
  includeMemories: true
})
```
