/**
 * Two-level cache:
 *   L1 — in-process Map (fastest, evicted on restart)
 *   L2 — SQLite (survives restarts, slower)
 */
import { getDb } from "./db.ts";
import { CONFIG } from "./config.ts";

interface L1Entry<T> {
  value: T;
  expiresAt: number;
}

const l1 = new Map<string, L1Entry<unknown>>();

// ──────────────────────────────────────────────────────────────────
// L1 operations
// ──────────────────────────────────────────────────────────────────
function l1Get<T>(key: string): T | null {
  const entry = l1.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { l1.delete(key); return null; }
  return entry.value as T;
}

function l1Set<T>(key: string, value: T, ttlMs = CONFIG.cache.l1TtlMs): void {
  // Evict oldest entries if at capacity
  if (l1.size >= CONFIG.cache.l1MaxSize) {
    const first = l1.keys().next().value;
    if (first !== undefined) l1.delete(first);
  }
  l1.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ──────────────────────────────────────────────────────────────────
// L2 (SQLite) operations
// ──────────────────────────────────────────────────────────────────
function l2Get<T>(key: string): T | null {
  const db = getDb();
  const row = db.query<{ value: string }, string>(
    "SELECT value FROM cache_l2 WHERE key = ? AND expires_at > unixepoch()"
  ).get(key);
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}

function l2Set<T>(key: string, value: T, ttlMs = CONFIG.cache.l2TtlMs): void {
  const db = getDb();
  const expiresAt = Math.floor((Date.now() + ttlMs) / 1000);
  db.run(
    "INSERT OR REPLACE INTO cache_l2 (key, value, expires_at) VALUES (?, ?, ?)",
    [key, JSON.stringify(value), expiresAt]
  );
}

// ──────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────
export function cacheGet<T>(key: string): T | null {
  return l1Get<T>(key) ?? l2Get<T>(key);
}

export function cacheSet<T>(
  key: string,
  value: T,
  l1TtlMs = CONFIG.cache.l1TtlMs,
  l2TtlMs = CONFIG.cache.l2TtlMs
): void {
  l1Set(key, value, l1TtlMs);
  l2Set(key, value, l2TtlMs);
}

export function cacheDelete(key: string): void {
  l1.delete(key);
  getDb().run("DELETE FROM cache_l2 WHERE key = ?", [key]);
}

export function cacheInvalidateProject(projectId: string): void {
  // Remove all L1 keys that contain the project id
  for (const key of l1.keys()) {
    if (key.includes(projectId)) l1.delete(key);
  }
  // Remove from L2 with LIKE
  getDb().run("DELETE FROM cache_l2 WHERE key LIKE ?", [`%${projectId}%`]);
}

export function cachePruneExpired(): void {
  getDb().run("DELETE FROM cache_l2 WHERE expires_at <= unixepoch()");
  const now = Date.now();
  for (const [key, entry] of l1) {
    if (now > entry.expiresAt) l1.delete(key);
  }
}

export function cacheStats() {
  const db = getDb();
  const l2Count = (db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM cache_l2").get([]) as any)?.n ?? 0;
  return { l1Size: l1.size, l2Size: l2Count };
}
