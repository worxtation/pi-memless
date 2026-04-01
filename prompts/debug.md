# memless — Debug / Investigate

## Step 1 — Recall related memories
```
memless_recall({ query: "{{problem}}", types: ["decision", "code", "pattern"], minImportance: 0.3 })
```

## Step 2 — Find relevant code
```
memless_context({
  query: "{{problem}}",
  maxTokens: 5000,
  maxResults: 6,
  includeMemories: true
})
```

## Step 3 — Diagnose

Analyse the context returned. Cross-reference with recalled memories.
Identify where actual behaviour diverges from expected pattern.

## Step 4 — After fixing, store the root cause
```
memless_remember({
  content: "Root cause of {{problem}}: {{rootCause}}. Fixed by {{fix}}.",
  type: "decision",
  importance: 0.75,
  tags: ["bugfix", "{{area}}"]
})
```
