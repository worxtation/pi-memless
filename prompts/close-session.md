# memless — Close Session / Save Learnings

Before ending this session, run ALL of the following:

## 1 — Save architectural decisions
For each significant decision made this session:
```
memless_remember({
  content: "<decision and rationale>",
  type: "decision",
  importance: 0.85,
  tags: ["<area>", "<technology>"]
})
```

## 2 — Save discovered patterns
For each recurring pattern identified:
```
memless_remember({
  content: "<pattern description>",
  type: "pattern",
  importance: 0.75,
  tags: ["<pattern-type>", "<module>"]
})
```

## 3 — Save important code references
```
memless_remember({
  content: "<key function/class and where to find it>",
  type: "code",
  importance: 0.7,
  tags: ["<module>"]
})
```

## 4 — Final checkpoint
```
memless_checkpoint({
  taskId: "session-{{date}}",
  description: "Session summary: <what was done>",
  progressPercent: 100,
  type: "milestone",
  decisions: ["<decision 1>", "<decision 2>"],
  learnings: ["<learning 1>"],
  nextAction: "<what to do next session>"
})
```

## 5 — View analytics (optional)
```
memless_analytics({ type: "summary" })
```
