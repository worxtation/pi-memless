/**
 * Configurable logger — zero dependencies.
 *
 * Level controlled by env MEMLESS_LOG:
 *   silent  → nothing
 *   error   → only errors   (DEFAULT — keeps terminal clean)
 *   info    → errors + lifecycle events worth knowing
 *   debug   → everything
 *
 * Usage:
 *   import { log } from "./logger.ts";
 *   log.info("server started");
 *   log.debug("cache hit for key: " + key);
 */

export type LogLevel = "silent" | "error" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error:  1,
  info:   2,
  debug:  3,
};

const raw = (process.env.MEMLESS_LOG ?? "error").toLowerCase() as LogLevel;
const CURRENT_LEVEL = LEVELS[raw] ?? LEVELS.error;

function write(msg: string) {
  process.stderr.write(`[memless] ${msg}\n`);
}

export const log = {
  error: (msg: string) => { if (CURRENT_LEVEL >= 1) write(msg); },
  info:  (msg: string) => { if (CURRENT_LEVEL >= 2) write(msg); },
  debug: (msg: string) => { if (CURRENT_LEVEL >= 3) write(msg); },
};
