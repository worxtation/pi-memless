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
import { startIndexJob, getIndexJob, searchProject, isIndexStale, getAnalytics } from "./search.ts";
import { createCheckpoint, getCheckpoint, listCheckpoints } from "./checkpoint.ts";
import { startBackgroundJobs }   from "./jobs.ts";
import { cacheStats, cacheGet, cacheSet } from "./cache.ts";

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

// GET /api/index/status/:jobId
route("GET", /^\/api\/index\/status\/([^/]+)$/, async (_req, url) => {
  const jobId = url.pathname.split("/").pop()!;
  const job = getIndexJob(jobId);
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

  // Check session cache
  const cacheKey = `optctx:${sessionId ?? ""}:${projectId}:${query}`;
  const cached = cacheGet<{ context: string; meta: unknown }>(cacheKey);
  if (cached) return json({ success: true, ...cached, meta: { ...cached.meta, cacheHit: true } });

  // 1. Code search
  const codeResults = await searchProject({ query, projectId, maxResults, responseMode: "summary" });

  // 2. Memory recall
  let memorySnippets: string[] = [];
  if (includeMemories) {
    const memories = await searchMemories({ query, projectId, sessionId, limit: 5, minImportance: 0.3 });
    memorySnippets = memories.map(m =>
      `[${m.type}|${new Date(m.createdAt * 1000).toISOString().slice(0, 10)}] ${m.content}`
    );
  }

  // 3. Build raw context
  const memBudget  = Math.floor(maxTokens * memoryBudgetRatio);
  const codeBudget = maxTokens - memBudget;

  let memSection   = memorySnippets.length
    ? `## Relevant Memories\n${memorySnippets.join("\n")}`
    : "";
  let codeSection  = codeResults.length
    ? `## Code Context\n${codeResults.map(r =>
        `### ${r.filePath} (L${r.lineStart}–${r.lineEnd})\n\`\`\`${r.language}\n${r.content}\n\`\`\``
      ).join("\n\n")}`
    : "";

  // 4. Compress if needed
  const { compress: doCompress, estimateTokens } = await import("./compression.ts");
  const rawCode = codeSection;
  const codeToks = estimateTokens(rawCode);
  if (codeToks > codeBudget && rawCode) {
    const compressed = doCompress(rawCode, "code_structure");
    codeSection = compressed.compressed;
  }

  const context = [memSection, codeSection].filter(Boolean).join("\n\n");
  const tokensSaved = estimateTokens(rawCode + memSection) - estimateTokens(context);

  const result = {
    context,
    meta: {
      codeResults: codeResults.length,
      memoriesCount: memorySnippets.length,
      tokensSaved: Math.max(0, tokensSaved),
      cacheHit: false,
    },
  };

  cacheSet(cacheKey, result);
  return json({ success: true, ...result });
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

console.error(`[memless] server running on http://localhost:${server.port}`);
