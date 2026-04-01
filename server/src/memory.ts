import { getDb } from "./db.ts";
import { embed, cosineSimilarity } from "./embeddings.ts";
import { CONFIG } from "./config.ts";
import { randomUUID } from "crypto";

export type MemoryType  = "preference" | "conversation" | "code" | "decision" | "pattern";
export type MemoryLevel = "persistent" | "project" | "user" | "session" | "ephemeral";

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  level: MemoryLevel;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  importance: number;
  tags: string[];
  accessCount: number;
  lastAccessed?: number;
  createdAt: number;
  score?: number;
}

export interface StoreParams {
  content: string;
  type: MemoryType;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  importance?: number;
  tags?: string[];
  linkTo?: string[];
}

export interface SearchParams {
  query: string;
  projectId?: string;
  sessionId?: string;
  types?: MemoryType[];
  minImportance?: number;
  limit?: number;
  includeRelated?: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Level resolution
// ──────────────────────────────────────────────────────────────────
function resolveLevel(type: MemoryType, agentId?: string, projectId?: string, sessionId?: string): MemoryLevel {
  if (agentId === "orchestrator" && type === "decision") return "persistent";
  if (agentId === "architect"    && (type === "pattern" || type === "code")) return "project";
  if (type === "decision" || type === "pattern") return "project";
  if (projectId) return "project";
  if (sessionId) return "session";
  return "ephemeral";
}

// ──────────────────────────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────────────────────────
export async function storeMemory(params: StoreParams): Promise<Memory> {
  const db = getDb();
  const id = `mem_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const level = resolveLevel(params.type, params.agentId, params.projectId, params.sessionId);
  const importance = params.importance ?? 0.5;
  const tags = params.tags ?? [];
  const tagsJson = JSON.stringify(tags);
  const now = Math.floor(Date.now() / 1000);

  let embeddingJson: string | null = null;
  try {
    const vec = await embed(params.content);
    embeddingJson = JSON.stringify(vec);
  } catch {}

  db.run(
    `INSERT INTO memories (id, content, type, level, project_id, session_id, user_id, agent_id,
      importance, tags, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.content, params.type, level, params.projectId ?? null,
     params.sessionId ?? null, params.userId ?? null, params.agentId ?? null,
     importance, tagsJson, embeddingJson, now]
  );

  // FTS index
  db.run(
    "INSERT INTO memories_fts (content, tags, memory_id) VALUES (?, ?, ?)",
    [params.content, tags.join(" "), id]
  );

  // Graph: explicit links
  if (params.linkTo?.length) {
    for (const targetId of params.linkTo) {
      addEdge(id, targetId, "RELATES_TO");
    }
  }

  // Graph: auto-link to similar memories (async, best-effort)
  if (embeddingJson) {
    autoLinkAsync(id, JSON.parse(embeddingJson), params.projectId).catch(() => {});
  }

  return { id, content: params.content, type: params.type, level,
           projectId: params.projectId, sessionId: params.sessionId,
           userId: params.userId, agentId: params.agentId,
           importance, tags, accessCount: 0, createdAt: now };
}

// ──────────────────────────────────────────────────────────────────
// Search
// ──────────────────────────────────────────────────────────────────
export async function searchMemories(params: SearchParams): Promise<Memory[]> {
  const db = getDb();
  const limit = params.limit ?? 10;
  const minImp = params.minImportance ?? 0.0;

  // Build base filter
  const conditions: string[] = ["m.importance >= ?"];
  const args: unknown[] = [minImp];

  if (params.projectId) { conditions.push("(m.project_id = ? OR m.level = 'persistent')"); args.push(params.projectId); }
  if (params.sessionId) { conditions.push("(m.session_id = ? OR m.level IN ('persistent','project'))"); args.push(params.sessionId); }
  if (params.types?.length) {
    conditions.push(`m.type IN (${params.types.map(() => "?").join(",")})`);
    args.push(...params.types);
  }

  const where = conditions.join(" AND ");

  // Vector search
  let vectorResults: Array<{ id: string; score: number }> = [];
  try {
    const qEmbed = await embed(params.query);
    const rows = db.query<{ id: string; embedding: string }, unknown[]>(
      `SELECT id, embedding FROM memories m WHERE ${where} AND embedding IS NOT NULL`
    ).all(...args);

    vectorResults = rows
      .map(r => ({ id: r.id, score: cosineSimilarity(qEmbed, JSON.parse(r.embedding)) }))
      .filter(r => r.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2);
  } catch {}

  // Keyword search (FTS)
  const safeQuery = params.query
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .join(" OR ");
  let keywordResults: Array<{ id: string; score: number }> = [];
  if (safeQuery) {
    try {
      const kRows = db.query<{ memory_id: string }, [string]>(
        `SELECT mf.memory_id FROM memories_fts mf
         JOIN memories m ON m.id = mf.memory_id
         WHERE mf.memories_fts MATCH ? AND ${where}
         ORDER BY rank LIMIT ?`
      ).all(safeQuery, ...(args as any[]), limit * 2);
      keywordResults = kRows.map((r, i) => ({ id: r.memory_id, score: 1 / (CONFIG.search.rrfK + i + 1) }));
    } catch {}
  }

  // RRF fusion
  const scores = new Map<string, number>();
  vectorResults.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (CONFIG.search.rrfK + i + 1));
  });
  keywordResults.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (CONFIG.search.rrfK + i + 1));
  });

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (!topIds.length) return [];

  // Fetch full records
  const placeholders = topIds.map(() => "?").join(",");
  const rows = db.query<any, any[]>(
    `SELECT * FROM memories WHERE id IN (${placeholders})`
  ).all(...topIds);

  // Update access counters
  const nowSec = Math.floor(Date.now() / 1000);
  db.run(
    `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id IN (${placeholders})`,
    [nowSec, ...topIds]
  );

  return rows.map(r => ({
    ...rowToMemory(r),
    score: scores.get(r.id) ?? 0,
  })).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// ──────────────────────────────────────────────────────────────────
// Graph helpers
// ──────────────────────────────────────────────────────────────────
function addEdge(sourceId: string, targetId: string, relation: string, weight = 1.0) {
  const db = getDb();
  const id = `edge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    db.run(
      "INSERT OR IGNORE INTO memory_edges (id, source_id, target_id, relation, weight) VALUES (?, ?, ?, ?, ?)",
      [id, sourceId, targetId, relation, weight]
    );
  } catch {}
}

async function autoLinkAsync(newId: string, newEmbedding: number[], projectId?: string) {
  const db = getDb();
  const filter = projectId
    ? "WHERE (project_id = ? OR level = 'persistent') AND id != ? AND embedding IS NOT NULL"
    : "WHERE id != ? AND embedding IS NOT NULL";
  const bindArgs = projectId ? [projectId, newId] : [newId];

  const rows = db.query<{ id: string; embedding: string }, any[]>(
    `SELECT id, embedding FROM memories ${filter} ORDER BY created_at DESC LIMIT 100`
  ).all(...bindArgs);

  for (const row of rows) {
    try {
      const sim = cosineSimilarity(newEmbedding, JSON.parse(row.embedding));
      if (sim >= 0.75) addEdge(newId, row.id, "RELATES_TO", sim);
    } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────
// Row → Memory
// ──────────────────────────────────────────────────────────────────
function rowToMemory(r: any): Memory {
  return {
    id: r.id,
    content: r.content,
    type: r.type,
    level: r.level,
    projectId: r.project_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    userId: r.user_id ?? undefined,
    agentId: r.agent_id ?? undefined,
    importance: r.importance,
    tags: safeParseJson(r.tags, []),
    accessCount: r.access_count ?? 0,
    lastAccessed: r.last_accessed ?? undefined,
    createdAt: r.created_at,
  };
}

function safeParseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s); } catch { return fallback; }
}
