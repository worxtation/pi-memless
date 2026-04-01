import { Database } from "bun:sqlite";
import { join } from "path";
import { CONFIG } from "./config.ts";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const dbPath = join(CONFIG.dataDir, "memless.db");
  _db = new Database(dbPath);

  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA busy_timeout = 5000");

  applySchema(_db);
  return _db;
}

function applySchema(db: Database) {
  db.exec(`
    -- ──────────────────────────────────────────────
    -- Code chunks (indexed project files)
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT    PRIMARY KEY,
      project_id  TEXT    NOT NULL,
      file_path   TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      embedding   TEXT,           -- JSON float[]
      chunk_index INTEGER NOT NULL DEFAULT 0,
      line_start  INTEGER NOT NULL DEFAULT 0,
      line_end    INTEGER NOT NULL DEFAULT 0,
      language    TEXT,
      file_mtime  INTEGER NOT NULL DEFAULT 0,
      indexed_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_file    ON chunks(project_id, file_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      file_path,
      project_id UNINDEXED,
      chunk_id   UNINDEXED,
      tokenize   = 'porter ascii'
    );

    -- ──────────────────────────────────────────────
    -- Memories
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS memories (
      id           TEXT    PRIMARY KEY,
      content      TEXT    NOT NULL,
      type         TEXT    NOT NULL,   -- preference|conversation|code|decision|pattern
      level        TEXT    NOT NULL DEFAULT 'session',
      project_id   TEXT,
      session_id   TEXT,
      user_id      TEXT,
      agent_id     TEXT,
      importance   REAL    NOT NULL DEFAULT 0.5,
      tags         TEXT    NOT NULL DEFAULT '[]',
      embedding    TEXT,              -- JSON float[]
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_type    ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_level   ON memories(level);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      tags,
      memory_id UNINDEXED,
      tokenize  = 'porter ascii'
    );

    -- ──────────────────────────────────────────────
    -- Knowledge graph edges
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS memory_edges (
      id         TEXT PRIMARY KEY,
      source_id  TEXT NOT NULL,
      target_id  TEXT NOT NULL,
      relation   TEXT NOT NULL DEFAULT 'RELATES_TO',
      weight     REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_id);

    -- ──────────────────────────────────────────────
    -- L2 cache
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS cache_l2 (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );

    -- ──────────────────────────────────────────────
    -- Index jobs (async indexing progress)
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS index_jobs (
      job_id           TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      project_path     TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      progress_current INTEGER NOT NULL DEFAULT 0,
      progress_total   INTEGER NOT NULL DEFAULT 0,
      files_indexed    INTEGER NOT NULL DEFAULT 0,
      chunks_indexed   INTEGER NOT NULL DEFAULT 0,
      error            TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at       INTEGER,
      completed_at     INTEGER
    );

    -- ──────────────────────────────────────────────
    -- Checkpoints
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS checkpoints (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      description TEXT,
      type        TEXT NOT NULL DEFAULT 'manual',
      state       TEXT NOT NULL,           -- JSON (TaskState)
      project_id  TEXT,
      agent_id    TEXT,
      memory_ids  TEXT NOT NULL DEFAULT '[]',
      file_changes TEXT NOT NULL DEFAULT '[]',
      expires_at  INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id);

    -- ──────────────────────────────────────────────
    -- Search analytics
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS search_analytics (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      query        TEXT    NOT NULL,
      project_id   TEXT,
      results_count INTEGER NOT NULL DEFAULT 0,
      cache_hit    INTEGER NOT NULL DEFAULT 0,
      duration_ms  INTEGER,
      searched_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ──────────────────────────────────────────────
    -- Project index metadata
    -- ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS project_meta (
      project_id   TEXT    PRIMARY KEY,
      project_path TEXT    NOT NULL,
      last_indexed INTEGER NOT NULL DEFAULT 0,
      file_count   INTEGER NOT NULL DEFAULT 0,
      chunk_count  INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
