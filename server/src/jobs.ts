/**
 * Background jobs — runs every 5 minutes:
 *   1. Memory decay (per-type adaptive rates)
 *   2. Promotion (high importance + frequency → persistent)
 *   3. Pruning (too old + low importance + low access)
 *   4. Redundancy filter (cosine > 0.95 → merge)
 *   5. Expired cache cleanup
 */
import { getDb } from "./db.ts";
import { cosineSimilarity } from "./embeddings.ts";
import { cachePruneExpired } from "./cache.ts";
import { CONFIG } from "./config.ts";
import { log } from "./logger.ts";

let _started = false;
let _runCount = 0;

const DECAY_RATES = CONFIG.jobs.decayRates as Record<string, number>;
const DEFAULT_DECAY = 0.92;
const DECAY_PERIOD_DAYS = 7;

export function startBackgroundJobs() {
  if (_started) return;
  _started = true;
  const intervalMs = CONFIG.jobs.consolidationIntervalMs;
  setInterval(() => runConsolidation(), intervalMs);
  log.info(`background jobs started (interval: ${intervalMs / 1000}s)`);
}

async function runConsolidation() {
  _runCount++;
  const db = getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = nowSec - DECAY_PERIOD_DAYS * 86400;
  const fortyFiveDaysAgo = nowSec - CONFIG.jobs.pruneAge / 1000;

  let promoted = 0, decayed = 0, pruned = 0;

  try {
    // ── 1. Decay: reduce importance for stale memories ───────────────
    const staleRows = db.query<{ id: string; type: string; importance: number }, [number]>(
      "SELECT id, type, importance FROM memories WHERE (last_accessed IS NULL OR last_accessed < ?) AND level != 'persistent'"
    ).all(sevenDaysAgo);

    for (const row of staleRows) {
      const rate = DECAY_RATES[row.type] ?? DEFAULT_DECAY;
      const newImp = row.importance * rate;
      db.run("UPDATE memories SET importance=? WHERE id=?", [newImp, row.id]);
      decayed++;
    }

    // ── 2. Promote: high importance + high access → persistent ───────
    const promotable = db.query<{ id: string }, []>(
      `SELECT id FROM memories
       WHERE level = 'session' AND importance >= ? AND access_count >= 3`
    ).all(CONFIG.jobs.promotionThreshold);

    for (const row of promotable) {
      db.run("UPDATE memories SET level='persistent' WHERE id=?", [row.id]);
      promoted++;
    }

    // ── 3. Prune: old + low importance + low access ─────────────────
    const pruneable = db.query<{ id: string }, [number, number, number]>(
      `SELECT id FROM memories
       WHERE created_at < ? AND importance < ? AND access_count < ?
         AND level NOT IN ('persistent', 'project')`
    ).all(fortyFiveDaysAgo, CONFIG.jobs.pruneImportance, CONFIG.jobs.pruneMinAccess);

    for (const row of pruneable) {
      // Delete FTS entries too
      db.run("DELETE FROM memories_fts WHERE memory_id=?", [row.id]);
      db.run("DELETE FROM memories WHERE id=?", [row.id]);
      pruned++;
    }

    // ── 4. Redundancy filter (every 5 cycles) ────────────────────────
    if (_runCount % 5 === 0) {
      await runRedundancyFilter();
    }

    // ── 5. Cache cleanup ─────────────────────────────────────────────
    cachePruneExpired();

    // Só logar se houve promoções ou purges relevantes (decay sozinho é ruído)
    if (promoted > 0 || pruned > 0) {
      log.info(`consolidation: +${promoted} promoted, ${pruned} pruned (${decayed} decayed silently)`);
    } else {
      log.debug(`consolidation: ${decayed} decayed, nothing promoted/pruned`);
    }
  } catch (err) {
    console.error("[memless] consolidation error:", err);
  }
}

async function runRedundancyFilter() {
  const db = getDb();
  // Load memories with embeddings
  const rows = db.query<{ id: string; embedding: string; importance: number; access_count: number }, []>(
    "SELECT id, embedding, importance, access_count FROM memories WHERE embedding IS NOT NULL ORDER BY importance DESC LIMIT 500"
  ).all();

  const merged = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    if (merged.has(rows[i].id)) continue;
    const embA = JSON.parse(rows[i].embedding) as number[];

    for (let j = i + 1; j < rows.length; j++) {
      if (merged.has(rows[j].id)) continue;
      const embB = JSON.parse(rows[j].embedding) as number[];
      const sim = cosineSimilarity(embA, embB);

      if (sim >= 0.95) {
        // Merge: keep the more important one, delete the other
        const keep   = rows[i].importance >= rows[j].importance ? rows[i] : rows[j];
        const remove = keep.id === rows[i].id ? rows[j] : rows[i];

        // Transfer edges
        db.run("UPDATE OR IGNORE memory_edges SET source_id=? WHERE source_id=?", [keep.id, remove.id]);
        db.run("UPDATE OR IGNORE memory_edges SET target_id=? WHERE target_id=?", [keep.id, remove.id]);

        // Update access count on keeper
        db.run(
          "UPDATE memories SET access_count=access_count+? WHERE id=?",
          [remove.access_count, keep.id]
        );

        // Delete duplicate
        db.run("DELETE FROM memories_fts WHERE memory_id=?", [remove.id]);
        db.run("DELETE FROM memories WHERE id=?", [remove.id]);
        merged.add(remove.id);
      }
    }
  }

  if (merged.size > 0) {
    log.info(`redundancy filter: merged ${merged.size} duplicates`);
  }
}
