#!/usr/bin/env bun
/**
 * memless — Intelligent context & memory management for AI coding agents
 * Exposes all capabilities as a local REST API consumed by the Pi extension.
 */
import { CONFIG }            from "./config.ts";
import { getDb }             from "./db.ts";
import { detectProvider }    from "./embeddings.ts";
import { compress }          from "./compression.ts";
import { storeMemory, searchMemories } from "./memory.ts";
import { startIndexJob, getIndexJob, getLatestIndexJob, searchProject, isIndexStale, getAnalytics } from "./search.ts";
import { createCheckpoint, getCheckpoint, listCheckpoints } from "./checkpoint.ts";
import { startBackgroundJobs }   from "./jobs.ts";
import { cacheStats, cacheGet, cacheSet } from "./cache.ts";
import { log } from "./logger.ts";
import { renderDashboard } from "./dashboard.ts";

// ── Path helper ────────────────────────────────────────────────
function normalizeWinPath(p: string): string {
  if (process.platform === "win32") {
    if (/^\/[a-zA-Z]\//.test(p)) p = p[1].toUpperCase() + ":" + p.slice(2);
    p = p.replace(/\//g, "\\");
  }
  return p;
}

// ── Bootstrap ────────────────────────────────────────────────────
getDb();
startBackgroundJobs();
detectProvider().catch(() => {});

// ── Router helper ────────────────────────────────────────────────
type Handler = (req: Request, url: URL) => Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

function route(method: string, path: string | RegExp, handler: Handler) {
  const pattern = typeof path === "string"
    ? new RegExp("^" + path.replace(/:[a-z_]+/g, "([^/]+)") + "$")
    : path;
  routes.push({ method, pattern, handler });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ success: false, error: message }, status);
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json(); } catch { return {}; }
}

// ── Routes ───────────────────────────────────────────────────────

// GET / — T5.1: dashboard browser
route("GET", "/", async () => {
  return new Response(renderDashboard(CONFIG.port), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

// GET /health
route("GET", "/health", async (_req, url) => {
  const provider = await detectProvider().catch(() => "unknown");
  const { l1Size, l2Size } = cacheStats();
  return json({ status: "ok", provider, cache: { l1Size, l2Size } });
});

// POST /api/index  — start async indexing job
route("POST", "/api/index", async (req) => {
  const body = await parseBody(req);
  const { projectPath, projectId, forceReindex = false } = body as any;
  if (!projectPath) return err("projectPath is required");
  const normalizedPath = normalizeWinPath(String(projectPath));
  const job = startIndexJob(normalizedPath, projectId ? String(projectId) : undefined, Boolean(forceReindex));
  return json({ success: true, data: job });
});

// GET /api/index/status/:jobId  (jobId = "__latest__" → most recent job)
route("GET", /^\/api\/index\/status\/([^/]+)$/, async (_req, url) => {
  const parts = url.pathname.split("/");
  const jobId    = parts.pop()!;
  const queryPid = url.searchParams.get("projectId") ?? undefined;

  const job = jobId === "__latest__"
    ? getLatestIndexJob(queryPid)
    : getIndexJob(jobId);

  if (!job) return err("Job not found", 404);
  return json({ success: true, data: job });
});

// POST /api/search  — hybrid semantic + keyword search
route("POST", "/api/search", async (req) => {
  const body = await parseBody(req);
  const { query, projectId, maxResults, minScore, include, exclude, responseMode } = body as any;
  if (!query)     return err("query is required");
  if (!projectId) return err("projectId is required");

  const stale = isIndexStale(String(projectId));
  const results = await searchProject({ query, projectId, maxResults, minScore, include, exclude, responseMode });
  return json({ success: true, data: results, meta: { stale } });
});

// POST /api/memory/store
route("POST", "/api/memory/store", async (req) => {
  const body = await parseBody(req);
  const { content, type, projectId, sessionId, userId, agentId, importance, tags, linkTo } = body as any;
  if (!content) return err("content is required");
  if (!type)    return err("type is required");

  const memory = await storeMemory({ content, type, projectId, sessionId, userId, agentId, importance, tags, linkTo });
  return json({ success: true, data: memory });
});

// POST /api/memory/search
route("POST", "/api/memory/search", async (req) => {
  const body = await parseBody(req);
  const { query, projectId, sessionId, types, minImportance, limit, includeRelated } = body as any;
  if (!query) return err("query is required");

  const memories = await searchMemories({ query, projectId, sessionId, types, minImportance, limit, includeRelated });
  return json({ success: true, data: memories });
});

// POST /api/compress
route("POST", "/api/compress", async (req) => {
  const body = await parseBody(req);
  const { content, strategy = "code_structure", targetRatio } = body as any;
  if (!content) return err("content is required");

  const result = compress(String(content), strategy);
  return json({ success: true, data: result });
});

// POST /api/context/optimized  — search + compress in one call
route("POST", "/api/context/optimized", async (req) => {
  const body = await parseBody(req);
  const {
    query, projectId, sessionId, userId,
    maxTokens = 4000, maxResults = 5,
    includeMemories = true, memoryBudgetRatio = 0.2,
  } = body as any;

  if (!query)     return err("query is required");
  if (!projectId) return err("projectId is required");

  // ── Cache key: sem sessionId para que L2 funcione cross-session (T1.2) ──
  const cacheKey = `optctx:${projectId}:${djb2(query)}`;
  const cached = cacheGet<{ context: string; meta: unknown }>(cacheKey);
  if (cached) return json({ success: true, ...cached, meta: { ...(cached.meta as any), cacheHit: true } });

  // 1. Code search — buscar full para compressão real (T1.1)
  const { responseMode: reqMode } = body as any;
  const codeResults = await searchProject({ query, projectId, maxResults, responseMode: reqMode ?? "full" });

  // 2. Memory recall
  let memorySnippets: string[] = [];
  if (includeMemories) {
    const memories = await searchMemories({ query, projectId, sessionId, limit: 5, minImportance: 0.3 });
    memorySnippets = memories.map(m =>
      `[${m.type}|${new Date(m.createdAt * 1000).toISOString().slice(0, 10)}] ${m.content.slice(0, 400)}`
    );
  }

  // 3. Build raw context
  const memBudget  = Math.floor(maxTokens * memoryBudgetRatio);
  const codeBudget = maxTokens - memBudget;

  const memSection  = memorySnippets.length
    ? `## Relevant Memories\n${memorySnippets.join("\n")}`
    : "";
  let codeSection   = codeResults.length
    ? `## Code Context\n${codeResults.map(r =>
        `### ${r.filePath} (L${r.lineStart}–${r.lineEnd})\n\`\`\`${r.language}\n${r.content}\n\`\`\``
      ).join("\n\n")}`
    : "";

  // 4. Medir tokens ANTES de comprimir (economia real) — T1.1
  const { compress: doCompress, estimateTokens } = await import("./compression.ts");
  const rawCodeToks = estimateTokens(codeSection);
  const rawTotalToks = rawCodeToks + estimateTokens(memSection);

  if (rawCodeToks > codeBudget && codeSection) {
    const compressed = doCompress(codeSection, "code_structure");
    codeSection = compressed.compressed;
    log.debug(`context compressed: ${rawCodeToks}→${estimateTokens(codeSection)} tokens`);
  }

  const context = [memSection, codeSection].filter(Boolean).join("\n\n");
  const tokensSaved = Math.max(0, rawTotalToks - estimateTokens(context));

  const result = {
    context,
    meta: {
      codeResults:   codeResults.length,
      memoriesCount: memorySnippets.length,
      tokensSaved,
      rawTokens:     rawTotalToks,
      cacheHit:      false,
    },
  };

  cacheSet(cacheKey, result);
  return json({ success: true, ...result });
});

// GET /api/memory/:id — T5.2: fetch memoria completa para modal de edição
route("GET", /^\/api\/memory\/([^/]+)$/, async (_req, url) => {
  const id = url.pathname.split("/").pop()!;
  const db = getDb();
  const row = db.query<any, [string]>("SELECT * FROM memories WHERE id=?").get(id);
  if (!row) return err("Memory not found", 404);
  const mem = {
    id: row.id, content: row.content, type: row.type, level: row.level,
    importance: row.importance, tags: safeParseJson(row.tags, []),
    createdAt: row.created_at, accessCount: row.access_count,
  };
  return json({ success: true, data: mem });
});

// PATCH /api/memory/:id — T5.2: editar conteudo e importancia
route("PATCH", /^\/api\/memory\/([^/]+)$/, async (req, url) => {
  const id   = url.pathname.split("/").pop()!;
  const body = await parseBody(req);
  const { content, importance, tags } = body as any;
  const db   = getDb();
  const sets: string[] = [];
  const args: unknown[] = [];
  if (content    !== undefined) { sets.push("content=?");    args.push(String(content)); }
  if (importance !== undefined) { sets.push("importance=?"); args.push(Number(importance)); }
  if (tags       !== undefined) { sets.push("tags=?");       args.push(JSON.stringify(tags)); }
  if (!sets.length) return err("nothing to update");
  args.push(id);
  const stmt = db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id=?`, args as any[]);
  if ((stmt as any).changes === 0) return err("Memory not found", 404);
  return json({ success: true, updated: id });
});

// DELETE /api/memory/:id — T4.1: memless_forget
route("DELETE", /^\/api\/memory\/([^/]+)$/, async (_req, url) => {
  const id = url.pathname.split("/").pop()!;
  const db = getDb();
  db.run("DELETE FROM memories_fts WHERE memory_id=?", [id]);
  db.run("DELETE FROM memory_edges WHERE source_id=? OR target_id=?", [id, id]);
  const stmt = db.run("DELETE FROM memories WHERE id=?", [id]);
  if ((stmt as any).changes === 0) return err("Memory not found", 404);
  return json({ success: true, deleted: id });
});

// POST /api/checkpoint/create
route("POST", "/api/checkpoint/create", async (req) => {
  const body = await parseBody(req);
  const { taskId, description, status = "in_progress", progressPercent = 0,
          currentStep, totalSteps, completedSteps, type = "manual",
          projectId, agentId, memoryIds, fileChanges, decisions, learnings,
          nextAction, pendingValidations } = body as any;
  if (!taskId) return err("taskId is required");
  if (!description) return err("description is required");

  const ckpt = createCheckpoint(
    { taskId, description, status, progressPercent, currentStep, totalSteps,
      completedSteps, decisions, learnings, fileChanges, nextAction, pendingValidations },
    { type, projectId, agentId, memoryIds, fileChanges }
  );
  return json({ success: true, data: ckpt });
});

// GET /api/checkpoint/:id
route("GET", /^\/api\/checkpoint\/([^/]+)$/, async (_req, url) => {
  const id = url.pathname.split("/").pop()!;
  const ckpt = getCheckpoint(id);
  if (!ckpt) return err("Checkpoint not found", 404);
  return json({ success: true, data: ckpt });
});

// GET /api/checkpoints  — list
route("GET", "/api/checkpoints", async (_req, url) => {
  const taskId = url.searchParams.get("taskId") ?? undefined;
  const projectId = url.searchParams.get("projectId") ?? undefined;
  return json({ success: true, data: listCheckpoints(taskId, projectId) });
});

// GET /api/analytics
route("GET", "/api/analytics", async (_req, url) => {
  const type = url.searchParams.get("type") ?? "summary";
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "10");
  const data = await getAnalytics(type, projectId, limit);
  return json({ success: true, data });
});

// GET /api/cache/stats
route("GET", "/api/cache/stats", async () => {
  return json({ success: true, data: cacheStats() });
});

// ── helpers locais ────────────────────────────────────────────────────
function safeParseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── djb2 hash para cache keys compactas ────────────────────────
function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ── Bun.serve ────────────────────────────────────────────────────
const server = Bun.serve({
  port: CONFIG.port,

  async fetch(request: Request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Match route
    for (const { method, pattern, handler } of routes) {
      if (request.method !== method) continue;
      if (pattern.test(url.pathname)) {
        try {
          const res = await handler(request, url);
          res.headers.set("Access-Control-Allow-Origin", "*");
          return res;
        } catch (e: any) {
          console.error("[memless] handler error:", e);
          return json({ success: false, error: String(e?.message ?? e) }, 500);
        }
      }
    }

    return json({ error: "Not found" }, 404);
  },

  error(error: Error) {
    console.error("[memless] server error:", error);
    return json({ error: error.message }, 500);
  },
});

log.error(`server running on http://localhost:${server.port}`);
