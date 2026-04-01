/**
 * pi-memless Extension
 *
 * Integrates the memless context/memory server with Pi:
 *   - Auto-starts the memless Bun server on session start
 *   - Registers all memless tools so the LLM can call them natively
 *   - Auto-indexes the project and recalls memories on each new prompt
 *   - Hooks into Pi compaction to compress code with memless engine (no LLM cost)
 *   - Saves session memories on shutdown
 *
 * Install:
 *   pi install npm:pi-memless
 *   pi install git:github.com/YOUR_USER/pi-memless
 *
 * Requirements: Bun (https://bun.sh) must be installed.
 *   Optional: Ollama with nomic-embed-text for semantic embeddings.
 *   Falls back to TF-IDF automatically when Ollama is offline.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, execSync } from "child_process";
import { join, dirname, resolve } from "path";
import { existsSync } from "fs";

// ── Package root resolution ──────────────────────────────────────
// This file lives at: <package-root>/extensions/memless/index.ts
// So package root is two levels up.
function getPackageRoot(): string {
  // import.meta.url works in both ESM and jiti contexts
  const thisFile = new URL(import.meta.url).pathname
    .replace(/^\/([A-Z]:)/, "$1")   // Windows: /C:/... → C:/...
    .replace(/\//g, sep());          // normalize to OS separator
  return resolve(dirname(dirname(dirname(thisFile))));
}

function sep() { return process.platform === "win32" ? "\\" : "/"; }

const PACKAGE_ROOT = getPackageRoot();
const SERVER_DIR   = join(PACKAGE_ROOT, "server");
const SERVER_ENTRY = join(SERVER_DIR, "src", "index.ts");

// ── Config ───────────────────────────────────────────────────────
const MEMLESS_PORT = parseInt(process.env.MEMLESS_PORT ?? "3434");
const BASE_URL     = `http://localhost:${MEMLESS_PORT}`;

// ── Session state ────────────────────────────────────────────────
let serverProcess: ReturnType<typeof spawn> | null = null;
let projectId   = "";
let projectPath = "";
let sessionId   = "";
let indexJobId  = "";
let initialRecallDone = false;
let toolCallCount = 0;           // T3.1 — rastrear atividade real da sessão

// ── Health cache (T1.3) ───────────────────────────────────────
let _serverHealthy    = false;
let _lastHealthCheck  = 0;
const HEALTH_CACHE_MS = 45_000; // 45s — detecta crash sem roundtrip em toda call

async function checkServer(): Promise<boolean> {
  const now = Date.now();
  if (_serverHealthy && now - _lastHealthCheck < HEALTH_CACHE_MS) return true;
  const ok = await isServerRunning();
  _serverHealthy   = ok;
  _lastHealthCheck = now;
  return ok;
}

// ── HTTP helpers ─────────────────────────────────────────────────
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body:    body ? JSON.stringify(body) : undefined,
    signal:  AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`memless API ${method} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

// ── Path normalization (Windows Git Bash / WSL paths) ────────────
function normPath(p: string): string {
  if (process.platform === "win32") {
    if (/^\/[a-zA-Z]\//.test(p))         // /c/foo → C:\foo
      p = p[1].toUpperCase() + ":" + p.slice(2);
    p = p.replace(/\//g, "\\");
  }
  return p;
}

// ── Detect bun executable ────────────────────────────────────────
function detectBun(): string {
  if (process.env.BUN_PATH) return process.env.BUN_PATH;
  const candidates = process.platform === "win32"
    ? ["bun.exe", join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe")]
    : ["bun", join(process.env.HOME ?? "", ".bun", "bin", "bun")];
  for (const c of candidates) {
    try { execSync(`"${c}" --version`, { stdio: "ignore" }); return c; } catch {}
  }
  return "bun"; // fallback, let it fail with a clear error
}

// ── Server lifecycle ─────────────────────────────────────────────
async function ensureServer(ctx: any): Promise<boolean> {
  if (await isServerRunning()) return true;

  if (!existsSync(SERVER_ENTRY)) {
    ctx.ui.notify(
      `[memless] server not found at ${SERVER_ENTRY}\n` +
      `Did the package install correctly? Try: pi install npm:pi-memless`,
      "warning"
    );
    return false;
  }

  const bun = detectBun();
  serverProcess = spawn(bun, ["src/index.ts"], {
    cwd:      SERVER_DIR,
    stdio:    ["ignore", "ignore", "pipe"],
    env:      { ...process.env, MEMLESS_PORT: String(MEMLESS_PORT) },
    detached: false,
  });

  serverProcess.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[memless] ${line}\n`);
  });

  serverProcess.on("error", (err: Error) => {
    ctx.ui.notify(`[memless] server process error: ${err.message}\nMake sure Bun is installed: https://bun.sh`, "error");
  });

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await isServerRunning()) return true;
  }

  ctx.ui.notify("[memless] server did not start in 15s — check that Bun is installed", "error");
  return false;
}

// ── T2.3: progress polling durante indexação ───────────────────────────
async function startIndexWithProgress(ctx: any) {
  try {
    const resp = await api<any>("POST", "/api/index", { projectPath, projectId });
    indexJobId = resp.data?.jobId ?? "";
    if (!indexJobId) { ctx.ui.setStatus("memless", "● ready"); return; }
    const poll = async () => {
      try {
        const s = await api<any>("GET", `/api/index/status/${indexJobId}`);
        const d = s.data;
        if (d.status === "running") {
          const pct = d.progressTotal > 0
            ? Math.round((d.progressCurrent / d.progressTotal) * 100) : 0;
          ctx.ui.setStatus("memless", `indexing ${d.progressCurrent}/${d.progressTotal} (${pct}%)`);
          setTimeout(poll, 1500);
        } else if (d.status === "completed") {
          ctx.ui.setStatus("memless", `● ready — ${d.filesIndexed} files, ${d.chunksIndexed} chunks`);
          setTimeout(() => ctx.ui.setStatus("memless", "● ready"), 5000);
        } else {
          ctx.ui.setStatus("memless", "● ready");
        }
      } catch { ctx.ui.setStatus("memless", "● ready"); }
    };
    setTimeout(poll, 800);
  } catch (e) {
    ctx.ui.notify(`[memless] index error: ${e}`, "warning");
    ctx.ui.setStatus("memless", "● ready");
  }
}

// ════════════════════════════════════════════════════════════════
// Extension entry point
// ════════════════════════════════════════════════════════════════
export default function (pi: ExtensionAPI) {

  // ── session_start ─────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    projectPath       = normPath(ctx.cwd);
    projectId         = projectPath.split(/[/\\]/).filter(Boolean).pop() ?? "project";
    sessionId         = `pi-${Date.now()}`;
    initialRecallDone = false;
    toolCallCount     = 0;
    _serverHealthy    = false;

    ctx.ui.setStatus("memless", "starting…");
    const ok = await ensureServer(ctx);
    if (!ok) { ctx.ui.setStatus("memless", "offline"); return; }
    _serverHealthy   = true;
    _lastHealthCheck = Date.now();

    // T2.3 — indexar com progresso em tempo real na status bar
    await startIndexWithProgress(ctx);
  });

  // ── before_agent_start: inject recalled memories once per session
  // T2.1 — recall seletivo: só prompts substantivos recebem memórias injetadas
  pi.on("before_agent_start", async (event, _ctx) => {
    if (initialRecallDone || !projectId || !await checkServer()) return;
    initialRecallDone = true;

    const prompt = (event.prompt ?? "").trim();
    const isTrivial =
      prompt.length < 35 ||
      /^(ls|pwd|cd |cat |echo |run |npm |bun |git )/i.test(prompt) ||
      /^(ok|yes|no|sure|thanks|done|got it|looks good)/i.test(prompt);
    if (isTrivial) return;

    const recallQuery = prompt.length > 10 ? prompt.slice(0, 150) : "project decisions patterns architecture";

    try {
      const resp = await api<any>("POST", "/api/memory/search", {
        query:         recallQuery,
        projectId,
        sessionId,
        types:         ["decision", "pattern", "code"],
        minImportance: 0.5,
        limit:         6,
      });

      const memories: any[] = resp.data ?? [];
      if (!memories.length) return;

      const MAX_SNIPPET = 400;
      const block = memories
        .map(m => {
          const snip = (m.content ?? "").length > MAX_SNIPPET
            ? m.content.slice(0, MAX_SNIPPET - 3) + "…"
            : m.content;
          return `• [${m.type}|${new Date(m.createdAt * 1000).toISOString().slice(0, 10)}] ${snip}`;
        })
        .join("\n");

      return {
        message: {
          customType: "memless-recall",
          content: `## memless: recalled context from previous sessions\n${block}`,
          display: true,
        },
      };
    } catch {}
  });

  // ── session_before_compact: replace LLM compaction with memless engine
  // T2.2 — compress + auto-extrair decisões para memórias
  pi.on("session_before_compact", async (event, ctx) => {
    if (!await checkServer()) return;

    const { preparation, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, firstKeptEntryId, tokensBefore } = preparation;

    ctx.ui.notify("[memless] compressing context (rule-based, no LLM cost)…", "info");

    try {
      const allMsgs = [...messagesToSummarize, ...turnPrefixMessages];
      const conversationText = serializeConversation(convertToLlm(allMsgs));

      const resp = await api<any>("POST", "/api/compress", {
        content:  conversationText,
        strategy: "conversation_summary",
      });

      const summary: string = resp.data?.compressed ?? "";
      if (!summary || signal.aborted) return;

      // Extrair e persistir decisões antes de descartar a conversa
      const DECISION_RE = /\b(decided|will use|fixed|implemented|chose|must|going to|resolved|refactored|added|changed|migrated)\b/i;
      const candidates = conversationText
        .split("\n")
        .filter(l => { const t = l.trim(); return t.length > 40 && t.length < 400 && DECISION_RE.test(t); })
        .map(l => ({ line: l.trim(), score: new Set((l.toLowerCase().match(/\b\w{4,}\b/g) ?? [])).size }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (candidates.length > 0 && !signal.aborted) {
        await Promise.allSettled(candidates.map(({ line }) =>
          api("POST", "/api/memory/store", {
            content: line, type: "decision", projectId, sessionId,
            importance: 0.55, tags: ["auto-compact", "extracted"],
          })
        ));
        ctx.ui.notify(`[memless] ↗ auto-saved ${candidates.length} decisions from compaction`, "info");
      }

      const saved = (resp.data?.originalTokens ?? 0) - (resp.data?.compressedTokens ?? 0);
      const pct   = resp.data?.ratio != null ? `${(resp.data.ratio * 100).toFixed(0)}%` : "";
      ctx.ui.notify(
        `[memless] compacted ${resp.data?.originalTokens}→${resp.data?.compressedTokens} tokens (${pct} saved, ${saved} tokens)`,
        "success"
      );

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          details: { memlessCompressed: true, ratio: resp.data?.ratio },
        },
      };
    } catch (e) {
      ctx.ui.notify(`[memless] compaction fallback to default (${e})`, "warning");
    }
  });

  // ── session_shutdown: persist session note ────────────────────
  pi.on("session_shutdown", async () => {
    // T3.1 — só salvar se houve atividade real (>= 3 tool calls)
    if (!projectId || !_serverHealthy || toolCallCount < 3) return;
    try {
      await api("POST", "/api/memory/store", {
        content:    `Worked on "${projectId}" — ${toolCallCount} tool calls on ${new Date().toISOString().slice(0, 10)}`,
        type:       "conversation",
        projectId,
        sessionId,
        importance: 0.25,
        tags:       ["session-summary", "auto"],
      });
    } catch {}
  });

  // ══════════════════════════════════════════════════════════════
  // TOOLS
  // ══════════════════════════════════════════════════════════════

  pi.registerTool({
    name:        "memless_index",
    label:       "memless: index project",
    description: "Index a project directory for semantic search. Returns a jobId — use memless_index_status to track progress.",
    parameters: Type.Object({
      projectPath:  Type.Optional(Type.String({ description: "Absolute path to index (defaults to cwd)" })),
      projectId:    Type.Optional(Type.String({ description: "Unique project ID (defaults to directory name)" })),
      forceReindex: Type.Optional(Type.Boolean({ description: "Force full reindex even if up to date", default: false })),
    }),
    async execute(_id, params, _sig, _upd, ctx) {
      toolCallCount++;
      const path = normPath(params.projectPath ?? ctx.cwd);
      const pid  = params.projectId ?? path.split(/[/\\]/).filter(Boolean).pop() ?? "project";
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running — run session_start first" }], details: {} };
      const resp = await api<any>("POST", "/api/index", { projectPath: path, projectId: pid, forceReindex: params.forceReindex ?? false });
      indexJobId = resp.data?.jobId ?? "";
      return { content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }], details: resp.data };
    },
  });

  pi.registerTool({
    name:        "memless_index_status",
    label:       "memless: index status",
    description: "Check the progress of an async indexing job started with memless_index.",
    parameters: Type.Object({
      jobId: Type.Optional(Type.String({ description: "Job ID (omit to use the latest started job)" })),
    }),
    async execute(_id, params, _sig, _upd) {
      toolCallCount++;
      const jid = params.jobId ?? indexJobId;
      if (!jid) return { content: [{ type: "text", text: "No active index job" }], details: {} };
      if (!await checkServer()) return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const resp = await api<any>("GET", `/api/index/status/${jid}`);
      const d = resp.data;
      const text = `status: ${d.status} | files: ${d.filesIndexed} | chunks: ${d.chunksIndexed} | progress: ${d.progressCurrent}/${d.progressTotal}`;
      return { content: [{ type: "text", text }], details: d };
    },
  });

  pi.registerTool({
    name:        "memless_search",
    label:       "memless: semantic search",
    description: "Hybrid semantic + keyword search across the indexed project (vector + FTS5 + RRF). Prefer this over grep/find/glob.",
    parameters: Type.Object({
      query:        Type.String({ description: "Natural language or keyword query" }),
      projectId:    Type.Optional(Type.String({ description: "Project ID (defaults to current project)" })),
      maxResults:   Type.Optional(Type.Number({ description: "Max results to return (default 10)" })),
      minScore:     Type.Optional(Type.Number({ description: "Min relevance score 0–1 (default 0.005)" })),
      responseMode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")], { description: "summary=preview only (saves tokens), full=complete content" })),
      include:      Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to include (e.g. src/**/*.ts)" })),
      exclude:      Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to exclude (e.g. **/*.test.*)" })),
    }),
    async execute(_id, params, _sig, _upd, ctx) {
      toolCallCount++;
      const pid = params.projectId ?? projectId ?? ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? "project";
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const resp = await api<any>("POST", "/api/search", { ...params, projectId: pid });
      const results: any[] = resp.data ?? [];
      if (!results.length)
        return { content: [{ type: "text", text: "No results found." }], details: { count: 0, stale: resp.meta?.stale } };
      const staleWarn = resp.meta?.stale ? "\n> ⚠️ Index is stale — run memless_index to refresh" : "";
      const text = results
        .map(r => `**${r.filePath}** L${r.lineStart}–${r.lineEnd} (score: ${r.score.toFixed(4)})\n${r.content}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text: staleWarn + text }], details: { count: results.length, stale: resp.meta?.stale } };
    },
  });

  pi.registerTool({
    name:        "memless_remember",
    label:       "memless: store memory",
    description: "Persist an important piece of information for future sessions. Call this immediately when you identify decisions, patterns, or architectural insights.",
    parameters: Type.Object({
      content:    Type.String({ description: "The information to remember" }),
      type:       Type.Union([
        Type.Literal("decision"), Type.Literal("pattern"),
        Type.Literal("code"),     Type.Literal("preference"),
        Type.Literal("conversation"),
      ], { description: "Memory type (decision decays slowest, conversation fastest)" }),
      importance: Type.Optional(Type.Number({ description: "Importance score 0–1 (default 0.7)" })),
      tags:       Type.Optional(Type.Array(Type.String(), { description: "Tags for easier retrieval" })),
      projectId:  Type.Optional(Type.String()),
      linkTo:     Type.Optional(Type.Array(Type.String(), { description: "Memory IDs to explicitly link" })),
    }),
    async execute(_id, params, _sig, _upd, ctx) {
      toolCallCount++;
      const pid = params.projectId ?? projectId ?? ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? "project";
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const resp = await api<any>("POST", "/api/memory/store", {
        ...params,
        importance: params.importance ?? 0.7,
        projectId: pid,
        sessionId,
      });
      // T4.2 — servidor pode retornar deduplicated:true
      if (resp.data?.deduplicated) {
        return {
          content: [{ type: "text", text: `↑ Similar memory reinforced — id: ${resp.data.id} | importance +0.1` }],
          details: resp.data,
        };
      }
      return {
        content: [{ type: "text", text: `✓ Memory stored — id: ${resp.data?.id} | level: ${resp.data?.level}` }],
        details: resp.data,
      };
    },
  });

  pi.registerTool({
    name:        "memless_recall",
    label:       "memless: recall memories",
    description: "Search persistent memories from previous sessions. Call at the start of every task before exploring files.",
    parameters: Type.Object({
      query:         Type.String({ description: "What to recall" }),
      types:         Type.Optional(Type.Array(Type.String(), { description: "Filter by type: decision, pattern, code, preference, conversation" })),
      minImportance: Type.Optional(Type.Number({ description: "Min importance 0–1 (default 0.3)" })),
      limit:         Type.Optional(Type.Number({ description: "Max results (default 10)" })),
      projectId:     Type.Optional(Type.String()),
    }),
    async execute(_id, params, _sig, _upd, ctx) {
      toolCallCount++;
      const pid = params.projectId ?? projectId ?? ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? "project";
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const resp = await api<any>("POST", "/api/memory/search", {
        ...params,
        projectId: pid,
        sessionId,
        minImportance: params.minImportance ?? 0.3,
        limit:         params.limit ?? 10,
      });
      const memories: any[] = resp.data ?? [];
      if (!memories.length)
        return { content: [{ type: "text", text: "No memories found for this query." }], details: {} };
      // T3.3 — truncar conteúdo longo; remover tags do output principal
      const MAX_CONTENT = 500;
      const text = memories.map(m => {
        const snip  = (m.content ?? "").length > MAX_CONTENT
          ? m.content.slice(0, MAX_CONTENT - 3) + "…"
          : m.content;
        const stale = (m.importance ?? 1) < 0.4 ? " ⚠️stale" : "";
        return `[${m.type} | imp: ${m.importance?.toFixed(2)}${stale} | ${new Date(m.createdAt * 1000).toISOString().slice(0, 10)}]\n${snip}`;
      }).join("\n\n");
      return { content: [{ type: "text", text }], details: { count: memories.length } };
    },
  });

  pi.registerTool({
    name:        "memless_compress",
    label:       "memless: compress context",
    description: "Reduce token count of a large code or text block using rule-based compression (no LLM — up to 98% reduction).",
    parameters: Type.Object({
      content:  Type.String({ description: "Content to compress" }),
      strategy: Type.Optional(Type.Union([
        Type.Literal("code_structure"),
        Type.Literal("conversation_summary"),
        Type.Literal("line_dedup"),           // T3.2 — renomeado de semantic_dedup
        Type.Literal("hierarchical"),
      ], { description: "code_structure (70-90%), conversation_summary (80-95%), line_dedup (30-50%), hierarchical (60-80%)" })),
    }),
    async execute(_id, params) {
      toolCallCount++;
      // T1.4 — short-circuit para conteúdo pequeno (< 200 tokens est.)
      const tokenEstimate = Math.ceil((params.content ?? "").length / 4);
      if (tokenEstimate < 200) {
        return {
          content: [{ type: "text", text: `<!-- memless: content too small to compress (${tokenEstimate} tokens est.) -->\n\n${params.content}` }],
          details: { skipped: true, originalTokens: tokenEstimate, tokensSaved: 0 },
        };
      }
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const resp = await api<any>("POST", "/api/compress", { strategy: "code_structure", ...params });
      const d = resp.data;
      const pct = d?.ratio != null ? `${(d.ratio * 100).toFixed(0)}%` : "0%";
      return {
        content: [{ type: "text", text: `## Compressed [${d?.strategy} | ${pct} saved | ${d?.originalTokens}→${d?.compressedTokens} tokens]\n\n${d?.compressed}` }],
        details: { originalTokens: d?.originalTokens, compressedTokens: d?.compressedTokens, ratio: d?.ratio },
      };
    },
  });

  pi.registerTool({
    name:        "memless_context",
    label:       "memless: optimized context",
    description: "One-shot: semantic search + persistent memories + compression in a single call. Maximum token efficiency. Use instead of reading multiple files.",
    parameters: Type.Object({
      query:             Type.String({ description: "What you need to understand" }),
      projectId:         Type.Optional(Type.String()),
      maxTokens:         Type.Optional(Type.Number({ description: "Max tokens in response (default 4000)" })),
      maxResults:        Type.Optional(Type.Number({ description: "Max code search results (default 5)" })),
      includeMemories:   Type.Optional(Type.Boolean({ description: "Include persistent memories (default true)" })),
      memoryBudgetRatio: Type.Optional(Type.Number({ description: "Fraction of maxTokens for memories (default 0.2)" })),
      responseMode:      Type.Optional(Type.Union([   // T4.3 — expor responseMode
        Type.Literal("summary"),
        Type.Literal("full"),
      ], { description: "summary=compressed snippets (default, saves tokens), full=complete file sections" })),
    }),
    async execute(_id, params, _sig, _upd, ctx) {
      toolCallCount++;
      const pid = params.projectId ?? projectId ?? ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? "project";
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const resp = await api<any>("POST", "/api/context/optimized", {
        maxTokens: 4000, maxResults: 5, includeMemories: true, memoryBudgetRatio: 0.2,
        ...params,
        projectId: pid,
        sessionId,
      });
      const m = resp.meta ?? {};
      const saved = m.tokensSaved > 0 ? `${m.tokensSaved} tokens saved` : "no compression needed";
      const header = `<!-- memless | ${m.codeResults ?? 0} code chunks | ${m.memoriesCount ?? 0} memories | ${saved} | raw: ${m.rawTokens ?? "?"} | cache: ${m.cacheHit ?? false} -->`;
      return {
        content: [{ type: "text", text: `${header}\n\n${resp.context ?? ""}` }],
        details: m,
      };
    },
  });

  pi.registerTool({
    name:        "memless_checkpoint",
    label:       "memless: create checkpoint",
    description: "Save a gzip-compressed task checkpoint for resumption. Use at milestones or before risky operations (large refactors, migrations, deletes).",
    parameters: Type.Object({
      taskId:          Type.String({ description: "Unique task identifier" }),
      description:     Type.String({ description: "What is being done" }),
      progressPercent: Type.Optional(Type.Number({ description: "0–100", default: 0 })),
      currentStep:     Type.Optional(Type.String({ description: "Current step name" })),
      type:            Type.Optional(Type.Union([Type.Literal("manual"), Type.Literal("milestone")], { description: "milestone = 14-day TTL, manual = 3-day TTL" })),
      decisions:       Type.Optional(Type.Array(Type.String(), { description: "Key decisions made" })),
      learnings:       Type.Optional(Type.Array(Type.String(), { description: "Insights discovered" })),
      fileChanges:     Type.Optional(Type.Array(Type.String(), { description: "Files modified" })),
      nextAction:      Type.Optional(Type.String({ description: "What to do next when restoring" })),
    }),
    async execute(_id, params, _sig, _upd, ctx) {
      toolCallCount++;
      const pid = (projectId || ctx.cwd.split(/[/\\]/).filter(Boolean).pop()) ?? "project";
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const resp = await api<any>("POST", "/api/checkpoint/create", { ...params, projectId: pid });
      const d = resp.data;
      const expires = d?.expiresAt ? new Date(d.expiresAt * 1000).toISOString().slice(0, 10) : "?";
      return {
        content: [{ type: "text", text: `✓ Checkpoint saved\nid: ${d?.id}\ntype: ${d?.type}\nexpires: ${expires}` }],
        details: d,
      };
    },
  });

  pi.registerTool({
    name:        "memless_analytics",
    label:       "memless: analytics",
    description: "View cache performance, search patterns, and usage metrics.",
    parameters: Type.Object({
      type:      Type.Optional(Type.Union([
        Type.Literal("summary"), Type.Literal("project"),
        Type.Literal("recent"),  Type.Literal("cache"),
      ], { description: "summary | project | recent | cache (default: summary)" })),
      projectId: Type.Optional(Type.String()),
      limit:     Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    async execute(_id, params, _sig, _upd, ctx) {
      toolCallCount++;
      const pid = params.projectId ?? projectId ?? ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? "project";
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      const qp = new URLSearchParams({ type: params.type ?? "summary", projectId: pid, limit: String(params.limit ?? 10) });
      const resp = await api<any>("GET", `/api/analytics?${qp}`);
      return {
        content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }],
        details: resp.data,
      };
    },
  });

  // ── T4.1: memless_forget ────────────────────────────────────────────
  pi.registerTool({
    name:        "memless_forget",
    label:       "memless: delete memory",
    description: "Delete a wrong or outdated memory by ID. Get the ID from memless_recall output.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "Memory ID (e.g. mem_1712345678_abc123) from recall output" }),
    }),
    async execute(_id, params) {
      toolCallCount++;
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      try {
        await api("DELETE", `/api/memory/${params.memoryId}`);
        return {
          content: [{ type: "text", text: `✓ Memory ${params.memoryId} deleted` }],
          details: { deleted: params.memoryId },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `✗ Failed to delete: ${e?.message ?? e}` }],
          details: { error: String(e) },
        };
      }
    },
  });

  // ── /memless command ──────────────────────────────────────────
  pi.registerCommand("memless", {
    description: "Show memless status, version, and tool list",
    handler: async (_args, ctx) => {
      const running = await isServerRunning();
      const health  = running ? await api<any>("GET", "/health").catch(() => null) : null;
      const provider = health?.provider ?? "—";
      const cache    = health?.cache ?? {};
      ctx.ui.notify(
        [
          `pi-memless  ${running ? "✅ online" : "❌ offline"}`,
          `server : localhost:${MEMLESS_PORT}`,
          `package: ${PACKAGE_ROOT}`,
          `project: ${projectId || "(none)"}`,
          `embed  : ${provider}`,
          `cache  : L1=${cache.l1Size ?? "?"} L2=${cache.l2Size ?? "?"}`,
          ``,
          `session: ${toolCallCount} tool calls`,
          ``,
          `tools: memless_search  memless_recall  memless_remember  memless_forget`,
          `       memless_context memless_compress memless_checkpoint`,
          `       memless_index   memless_analytics`,
          ``,
          `dashboard: http://localhost:${MEMLESS_PORT}`,
        ].join("\n"),
        "info"
      );
    },
  });
}
