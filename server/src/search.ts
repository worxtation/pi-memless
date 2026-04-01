import { getDb } from "./db.ts";
import { embed, cosineSimilarity } from "./embeddings.ts";
import { cacheGet, cacheSet, cacheInvalidateProject } from "./cache.ts";
import { CONFIG } from "./config.ts";
import { randomUUID } from "crypto";
import { readdirSync, statSync, readFileSync } from "fs";
import { join, extname, relative } from "path";

export interface SearchResult {
  id: string;
  filePath: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  preview?: string;
}

export interface IndexStats {
  filesIndexed: number;
  chunksIndexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface IndexJob {
  jobId: string;
  projectId: string;
  projectPath: string;
  status: "pending" | "running" | "completed" | "failed";
  progressCurrent: number;
  progressTotal: number;
  filesIndexed: number;
  chunksIndexed: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

// ──────────────────────────────────────────────────────────────────
// Index project (async — returns jobId immediately)
// ──────────────────────────────────────────────────────────────────
export function startIndexJob(projectPath: string, projectId?: string, forceReindex = false): IndexJob {
  const db = getDb();
  projectPath = normalizePath(projectPath);
  const finalProjectId = projectId ?? projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const jobId = `job_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const now = Math.floor(Date.now() / 1000);

  db.run(
    `INSERT INTO index_jobs (job_id, project_id, project_path, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    [jobId, finalProjectId, projectPath, now]
  );

  // Fire-and-forget
  runIndexJob(jobId, finalProjectId, projectPath, forceReindex).catch(err => {
    db.run(
      "UPDATE index_jobs SET status='failed', error=?, completed_at=unixepoch() WHERE job_id=?",
      [String(err), jobId]
    );
  });

  return getIndexJob(jobId)!;
}

export function getIndexJob(jobId: string): IndexJob | null {
  const db = getDb();
  const row = db.query<any, [string]>("SELECT * FROM index_jobs WHERE job_id = ?").get(jobId);
  if (!row) return null;
  return {
    jobId: row.job_id, projectId: row.project_id, projectPath: row.project_path,
    status: row.status, progressCurrent: row.progress_current,
    progressTotal: row.progress_total, filesIndexed: row.files_indexed,
    chunksIndexed: row.chunks_indexed, error: row.error ?? undefined,
    createdAt: row.created_at, startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

// ──────────────────────────────────────────────────────────────────
// Core indexing logic
// ──────────────────────────────────────────────────────────────────
async function runIndexJob(jobId: string, projectId: string, projectPath: string, force: boolean) {
  const db = getDb();
  db.run("UPDATE index_jobs SET status='running', started_at=unixepoch() WHERE job_id=?", [jobId]);

  const files = collectFiles(projectPath);
  db.run("UPDATE index_jobs SET progress_total=? WHERE job_id=?", [files.length, jobId]);

  let filesIndexed = 0, chunksIndexed = 0, skipped = 0;
  const start = Date.now();

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    db.run("UPDATE index_jobs SET progress_current=? WHERE job_id=?", [fi + 1, jobId]);

    try {
      const stat = statSync(file);
      const mtime = Math.floor(stat.mtimeMs);
      const relPath = relative(projectPath, file);

      // Check staleness
      if (!force) {
        const existing = db.query<{ file_mtime: number }, [string, string]>(
          "SELECT file_mtime FROM chunks WHERE project_id=? AND file_path=? LIMIT 1"
        ).get(projectId, relPath);

        if (existing && existing.file_mtime >= mtime) { skipped++; continue; }
      }

      // Remove old chunks for this file
      db.run("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE project_id=? AND file_path=?)", [projectId, relPath]);
      db.run("DELETE FROM chunks WHERE project_id=? AND file_path=?", [projectId, relPath]);

      // Read & chunk
      const content = readFileSync(file, "utf-8");
      const chunks = chunkFile(content, relPath);

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const id = `chunk_${Date.now()}_${randomUUID().slice(0, 6)}`;
        const lang = detectLanguage(relPath);

        let embeddingJson: string | null = null;
        try {
          const vec = await embed(chunk.content);
          embeddingJson = JSON.stringify(vec);
        } catch {}

        db.run(
          `INSERT INTO chunks (id, project_id, file_path, content, embedding, chunk_index,
            line_start, line_end, language, file_mtime)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, projectId, relPath, chunk.content, embeddingJson,
           ci, chunk.lineStart, chunk.lineEnd, lang, mtime]
        );

        db.run(
          "INSERT INTO chunks_fts (content, file_path, project_id, chunk_id) VALUES (?, ?, ?, ?)",
          [chunk.content, relPath, projectId, id]
        );

        chunksIndexed++;
      }

      filesIndexed++;
    } catch (err) {
      // non-fatal: skip file
    }
  }

  // Update project meta
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT OR REPLACE INTO project_meta (project_id, project_path, last_indexed, file_count, chunk_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, projectPath, now, filesIndexed, chunksIndexed, now]
  );

  db.run(
    `UPDATE index_jobs SET status='completed', files_indexed=?, chunks_indexed=?, completed_at=unixepoch() WHERE job_id=?`,
    [filesIndexed, chunksIndexed, jobId]
  );

  cacheInvalidateProject(projectId);
}

// ──────────────────────────────────────────────────────────────────
// Hybrid search
// ──────────────────────────────────────────────────────────────────
export interface SearchProjectParams {
  query: string;
  projectId: string;
  maxResults?: number;
  minScore?: number;
  include?: string[];
  exclude?: string[];
  responseMode?: "summary" | "full";
}

export async function searchProject(params: SearchProjectParams): Promise<SearchResult[]> {
  const db = getDb();
  const maxResults = params.maxResults ?? 10;
  const minScore   = params.minScore   ?? 0.005;  // RRF scores are ~0.016-0.033
  const cacheKey = `search:${params.projectId}:${params.query}:${maxResults}`;

  const cached = cacheGet<SearchResult[]>(cacheKey);
  if (cached) return cached;

  const before = Date.now();

  // Vector search
  let vectorRank = new Map<string, number>();
  try {
    const qEmbed = await embed(params.query);
    const rows = db.query<{ id: string; embedding: string; file_path: string }, [string]>(
      "SELECT id, embedding, file_path FROM chunks WHERE project_id=? AND embedding IS NOT NULL"
    ).all(params.projectId);

    const scored = rows
      .filter(r => matchesGlobs(r.file_path, params.include, params.exclude))
      .map(r => ({ id: r.id, sim: cosineSimilarity(qEmbed, JSON.parse(r.embedding)) }))
      .filter(r => r.sim > 0.1)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, maxResults * 3);

    scored.forEach((r, i) => vectorRank.set(r.id, i));
  } catch {}

  // Keyword search (FTS5)
  let keywordRank = new Map<string, number>();
  // Build FTS5 OR query from individual terms (avoids AND-too-strict)
  const safeQ = params.query
    .replace(/[^a-zA-Z0-9_ ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .join(" OR ");
  if (safeQ) {
    try {
      const rows = db.query<{ chunk_id: string }, [string, string]>(
        `SELECT cf.chunk_id FROM chunks_fts cf
         JOIN chunks c ON c.id = cf.chunk_id
         WHERE cf.chunks_fts MATCH ? AND c.project_id = ?
         ORDER BY rank LIMIT ?`
      ).all(safeQ, params.projectId, maxResults * 3);
      rows.forEach((r, i) => keywordRank.set(r.chunk_id, i));
    } catch {}
  }

  // RRF fusion
  const scores = new Map<string, number>();
  for (const [id, rank] of vectorRank) scores.set(id, (scores.get(id) ?? 0) + 1 / (CONFIG.search.rrfK + rank + 1));
  for (const [id, rank] of keywordRank) scores.set(id, (scores.get(id) ?? 0) + 1 / (CONFIG.search.rrfK + rank + 1));

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, s]) => s >= minScore)
    .slice(0, maxResults)
    .map(([id]) => id);

  if (!topIds.length) return [];

  const placeholders = topIds.map(() => "?").join(",");
  const rows = db.query<any, any[]>(
    `SELECT * FROM chunks WHERE id IN (${placeholders})`
  ).all(...topIds);

  const results: SearchResult[] = rows.map(r => {
    const content = params.responseMode === "summary"
      ? r.content.split("\n").slice(0, 6).join("\n")
      : r.content;
    return {
      id: r.id, filePath: r.file_path, content,
      lineStart: r.line_start, lineEnd: r.line_end,
      language: r.language ?? "", score: scores.get(r.id) ?? 0,
      preview: r.content.split("\n")[0].slice(0, 120),
    };
  }).sort((a, b) => b.score - a.score);

  // Track analytics
  db.run(
    "INSERT INTO search_analytics (query, project_id, results_count, duration_ms) VALUES (?, ?, ?, ?)",
    [params.query, params.projectId, results.length, Date.now() - before]
  );

  cacheSet(cacheKey, results);
  return results;
}

// ──────────────────────────────────────────────────────────────────
// Staleness check
// ──────────────────────────────────────────────────────────────────
export function isIndexStale(projectId: string): boolean {
  const db = getDb();
  const meta = db.query<{ last_indexed: number }, [string]>(
    "SELECT last_indexed FROM project_meta WHERE project_id=?"
  ).get(projectId);
  if (!meta) return true;

  const ageMs = Date.now() - meta.last_indexed * 1000;
  return ageMs > CONFIG.search.staleAfterMs;
}

// ──────────────────────────────────────────────────────────────────
// Analytics
// ──────────────────────────────────────────────────────────────────
export async function getAnalytics(type: string, projectId?: string, limit = 10) {
  const db = getDb();
  switch (type) {
    case "summary": {
      const totalSearches = (db.query<{n:number},[]>("SELECT COUNT(*) as n FROM search_analytics").get([]) as any)?.n ?? 0;
      const avgMs = (db.query<{avg:number},[]>("SELECT AVG(duration_ms) as avg FROM search_analytics").get([]) as any)?.avg ?? 0;
      const topQueries = db.query<{query:string;cnt:number},[]>(
        "SELECT query, COUNT(*) as cnt FROM search_analytics GROUP BY query ORDER BY cnt DESC LIMIT ?"
      ).all(limit);
      return { totalSearches, avgDurationMs: Math.round(avgMs), topQueries };
    }
    case "project": {
      const rows = db.query<any,[string]>(
        "SELECT * FROM search_analytics WHERE project_id=? ORDER BY searched_at DESC LIMIT ?"
      ).all(projectId ?? "", limit);
      return rows;
    }
    case "cache": {
      return { cacheNote: "use /api/cache/stats for live stats" };
    }
    case "recent": {
      return db.query<any,[number]>(
        "SELECT * FROM search_analytics ORDER BY searched_at DESC LIMIT ?"
      ).all(limit);
    }
    default: return {};
  }
}

// ──────────────────────────────────────────────────────────────────
// File helpers
// ──────────────────────────────────────────────────────────────────
function normalizePath(p: string): string {
  if (process.platform === "win32") {
    // /z/foo → Z:\foo
    if (/^\/[a-zA-Z]\//.test(p)) {
      p = p[1].toUpperCase() + ":" + p.slice(2);
    }
    // Z:/foo → Z:\foo (normalize all forward slashes)
    p = p.replace(/\//g, "\\");
  }
  return p;
}

function collectFiles(dir: string): string[] {
  dir = normalizePath(dir);
  const results: string[] = [];

  function walk(current: string) {
    let entries: string[];
    try { entries = readdirSync(current); } catch { return; }

    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".pi") continue;
      const fullPath = join(current, entry);
      let st;
      try { st = statSync(fullPath); } catch { continue; }

      if (st.isDirectory()) {
        if (!CONFIG.skipDirs.has(entry)) walk(fullPath);
      } else if (st.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (CONFIG.includeExtensions.has(ext) && st.size < 500_000) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

interface Chunk { content: string; lineStart: number; lineEnd: number; }

function chunkFile(content: string, filePath: string): Chunk[] {
  const lines = content.split("\n");
  if (lines.length <= CONFIG.search.chunkLines) {
    return [{ content, lineStart: 0, lineEnd: lines.length - 1 }];
  }

  const chunks: Chunk[] = [];
  const size    = CONFIG.search.chunkLines;
  const overlap = CONFIG.search.chunkOverlapLines;
  const step    = size - overlap;

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + size, lines.length);
    chunks.push({
      content: lines.slice(start, end).join("\n"),
      lineStart: start,
      lineEnd: end - 1,
    });
    if (end === lines.length) break;
  }

  return chunks;
}

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const MAP: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
    ".c": "c", ".cpp": "cpp", ".h": "c", ".cs": "csharp",
    ".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml", ".sql": "sql", ".sh": "shell", ".css": "css", ".html": "html",
  };
  return MAP[ext] ?? "text";
}

function matchesGlobs(filePath: string, include?: string[], exclude?: string[]): boolean {
  if (exclude?.some(g => minimatch(filePath, g))) return false;
  if (include?.length && !include.some(g => minimatch(filePath, g))) return false;
  return true;
}

// Minimal glob matcher (no external dep)
function minimatch(str: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§/g, ".*") + "$"
  );
  return regex.test(str);
}
