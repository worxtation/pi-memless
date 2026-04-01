import { getDb } from "./db.ts";
import { CONFIG } from "./config.ts";
import { randomUUID } from "crypto";
import { gzipSync, gunzipSync } from "zlib";

export type CheckpointType = "manual" | "milestone" | "auto";

export interface TaskState {
  taskId: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "paused";
  progressPercent: number;
  currentStep?: string;
  totalSteps?: number;
  completedSteps?: number;
  decisions?: string[];
  learnings?: string[];
  fileChanges?: string[];
  nextAction?: string;
  pendingValidations?: string[];
}

export interface Checkpoint {
  id: string;
  taskId: string;
  description?: string;
  type: CheckpointType;
  state: TaskState;
  projectId?: string;
  agentId?: string;
  memoryIds: string[];
  fileChanges: string[];
  expiresAt: number;
  createdAt: number;
}

export function createCheckpoint(state: TaskState, opts: {
  type?: CheckpointType;
  projectId?: string;
  agentId?: string;
  memoryIds?: string[];
  fileChanges?: string[];
} = {}): Checkpoint {
  const db = getDb();
  const id = `ckpt_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const type = opts.type ?? "manual";
  const now = Math.floor(Date.now() / 1000);
  const ttlMs = type === "milestone"
    ? CONFIG.checkpoint.milestoneTtlMs
    : CONFIG.checkpoint.autoTtlMs;
  const expiresAt = Math.floor((Date.now() + ttlMs) / 1000);

  const memoryIds  = opts.memoryIds  ?? [];
  const fileChanges = opts.fileChanges ?? state.fileChanges ?? [];

  // Gzip compress the state
  const stateJson  = JSON.stringify(state);
  const compressed = gzipSync(Buffer.from(stateJson));

  db.run(
    `INSERT INTO checkpoints
       (id, task_id, description, type, state, project_id, agent_id, memory_ids, file_changes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, state.taskId, state.description, type,
      compressed.toString("base64"),
      opts.projectId ?? null, opts.agentId ?? null,
      JSON.stringify(memoryIds), JSON.stringify(fileChanges),
      expiresAt, now,
    ]
  );

  pruneExpired();

  return { id, taskId: state.taskId, description: state.description, type,
           state, projectId: opts.projectId, agentId: opts.agentId,
           memoryIds, fileChanges, expiresAt, createdAt: now };
}

export function getCheckpoint(id: string): Checkpoint | null {
  const db = getDb();
  const row = db.query<any, [string]>(
    "SELECT * FROM checkpoints WHERE id=? AND (expires_at IS NULL OR expires_at > unixepoch())"
  ).get(id);
  return row ? rowToCheckpoint(row) : null;
}

export function listCheckpoints(taskId?: string, projectId?: string): Checkpoint[] {
  const db = getDb();
  let q = "SELECT * FROM checkpoints WHERE (expires_at IS NULL OR expires_at > unixepoch())";
  const args: unknown[] = [];
  if (taskId)    { q += " AND task_id=?";   args.push(taskId); }
  if (projectId) { q += " AND project_id=?"; args.push(projectId); }
  q += " ORDER BY created_at DESC LIMIT 50";
  return db.query<any, any[]>(q).all(...args).map(rowToCheckpoint);
}

function rowToCheckpoint(row: any): Checkpoint {
  let state: TaskState;
  try {
    const buf = Buffer.from(row.state, "base64");
    state = JSON.parse(gunzipSync(buf).toString());
  } catch {
    state = { taskId: row.task_id, description: row.description, status: "paused", progressPercent: 0 };
  }
  return {
    id: row.id, taskId: row.task_id, description: row.description ?? undefined,
    type: row.type, state, projectId: row.project_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    memoryIds:   safeJson(row.memory_ids, []),
    fileChanges: safeJson(row.file_changes, []),
    expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

function pruneExpired() {
  getDb().run("DELETE FROM checkpoints WHERE expires_at <= unixepoch()");
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s); } catch { return fallback; }
}
