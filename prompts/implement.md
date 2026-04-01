# memless — Implement Feature

## Step 1 — Recover context
```
memless_recall({ query: "{{feature}} decisions and patterns", types: ["decision", "pattern"] })
```

## Step 2 — Explore relevant code
```
memless_search({ query: "{{feature}}", maxResults: 8, responseMode: "summary" })
```

## Step 3 — Implement `{{feature}}` following the patterns found.

## Step 4 — Save discoveries
After implementing, immediately run:
```
memless_remember({
  content: "{{decision}}",
  type: "decision",
  importance: 0.8,
  tags: ["{{tag1}}", "{{tag2}}"]
})
```

## Step 5 — Checkpoint
```
memless_checkpoint({
  taskId: "feat-{{feature}}",
  description: "Implementing {{feature}}",
  progressPercent: {{progress}},
  type: "milestone",
  nextAction: "{{next}}"
})
```
