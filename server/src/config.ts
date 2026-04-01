import { join } from "path";
import os from "os";

export const CONFIG = {
  port: parseInt(process.env.MEMLESS_PORT ?? "3434"),
  dataDir: process.env.MEMLESS_DATA_DIR ?? join(os.homedir(), ".config", "memless"),
  ollama: {
    url: process.env.OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
  },
  mistral: {
    apiKey: process.env.MISTRAL_API_KEY ?? "",
    model: process.env.MISTRAL_EMBED_MODEL ?? "mistral-embed",
  },
  cache: {
    l1MaxSize: 500,
    l1TtlMs: 5 * 60 * 1000,       // 5 min
    l2TtlMs: 60 * 60 * 1000,      // 1 hour
  },
  search: {
    rrfK: 60,
    chunkLines: 80,
    chunkOverlapLines: 15,
    staleAfterMs: 24 * 60 * 60 * 1000,  // 24h
  },
  jobs: {
    consolidationIntervalMs: 5 * 60 * 1000, // 5 min
    decayRates: {
      decision: 0.97,
      pattern: 0.94,
      code: 0.90,
      preference: 0.88,
      conversation: 0.78,
    },
    pruneAge: 45 * 24 * 60 * 60 * 1000, // 45 days
    pruneImportance: 0.25,
    pruneMinAccess: 2,
    promotionThreshold: 0.85,
  },
  checkpoint: {
    autoTtlMs: 3 * 24 * 60 * 60 * 1000,       // 3 days
    milestoneTtlMs: 14 * 24 * 60 * 60 * 1000,  // 14 days
  },
  skipDirs: new Set([
    "node_modules", ".git", "dist", "build", ".next", ".nuxt",
    "__pycache__", "venv", ".venv", "coverage", ".turbo", ".cache",
    "target", "vendor", ".idea", ".vscode", "out", ".output",
  ]),
  includeExtensions: new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs",
    ".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml",
    ".sql", ".sh", ".bash", ".zsh", ".css", ".scss", ".html", ".vue", ".svelte",
  ]),
};

// Ensure data dir exists
import { mkdirSync } from "fs";
mkdirSync(CONFIG.dataDir, { recursive: true });
