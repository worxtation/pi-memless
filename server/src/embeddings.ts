import { CONFIG } from "./config.ts";
import { log } from "./logger.ts";

export type EmbeddingProvider = "ollama" | "openai" | "mistral" | "tfidf";

let _provider: EmbeddingProvider | null = null;
let _ollamaOk = false;

// ──────────────────────────────────────────────────────────────────
// Provider detection
// ──────────────────────────────────────────────────────────────────
export async function detectProvider(): Promise<EmbeddingProvider> {
  if (_provider) return _provider;

  // 1. Try Ollama
  try {
    const res = await fetch(`${CONFIG.ollama.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      _ollamaOk = true;
      _provider = "ollama";
      log.info("embeddings: ollama");
      return _provider;
    }
  } catch {}

  // 2. Try OpenAI
  if (CONFIG.openai.apiKey) {
    _provider = "openai";
    log.info("embeddings: openai");
    return _provider;
  }

  // 3. Try Mistral
  if (CONFIG.mistral.apiKey) {
    _provider = "mistral";
    log.info("embeddings: mistral");
    return _provider;
  }

  // 4. Fallback: TF-IDF (no network, no API)
  _provider = "tfidf";
  log.info("embeddings: tfidf fallback (install Ollama for semantic search)");
  return _provider;
}

// ──────────────────────────────────────────────────────────────────
// Public: embed a single text
// ──────────────────────────────────────────────────────────────────
export async function embed(text: string): Promise<number[]> {
  const provider = await detectProvider();

  switch (provider) {
    case "ollama":  return embedOllama(text);
    case "openai":  return embedOpenAI(text);
    case "mistral": return embedMistral(text);
    default:        return embedTFIDF(text);
  }
}

// ──────────────────────────────────────────────────────────────────
// Cosine similarity (pure JS)
// ──────────────────────────────────────────────────────────────────
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ──────────────────────────────────────────────────────────────────
// Ollama
// ──────────────────────────────────────────────────────────────────
async function embedOllama(text: string): Promise<number[]> {
  const res = await fetch(`${CONFIG.ollama.url}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CONFIG.ollama.model, prompt: text }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
  const data = await res.json() as { embedding: number[] };
  return data.embedding;
}

// ──────────────────────────────────────────────────────────────────
// OpenAI
// ──────────────────────────────────────────────────────────────────
async function embedOpenAI(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CONFIG.openai.apiKey}`,
    },
    body: JSON.stringify({ model: CONFIG.openai.model, input: text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenAI embed error: ${res.status}`);
  const data = await res.json() as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

// ──────────────────────────────────────────────────────────────────
// Mistral
// ──────────────────────────────────────────────────────────────────
async function embedMistral(text: string): Promise<number[]> {
  const res = await fetch("https://api.mistral.ai/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CONFIG.mistral.apiKey}`,
    },
    body: JSON.stringify({ model: CONFIG.mistral.model, input: [text] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Mistral embed error: ${res.status}`);
  const data = await res.json() as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

// ──────────────────────────────────────────────────────────────────
// TF-IDF fallback (no API — sparse vector based on term frequency)
// Produces a 1024-dim vector keyed to word hashes
// ──────────────────────────────────────────────────────────────────
const TFIDF_DIM = 1024;

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function hashTerm(term: string): number {
  let h = 0;
  for (let i = 0; i < term.length; i++) {
    h = (Math.imul(31, h) + term.charCodeAt(i)) >>> 0;
  }
  return h % TFIDF_DIM;
}

function embedTFIDF(text: string): number[] {
  const tokens = tokenize(text);
  const vec = new Array<number>(TFIDF_DIM).fill(0);
  const counts = new Map<string, number>();

  for (const tok of tokens) {
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }

  for (const [term, count] of counts) {
    const idx = hashTerm(term);
    vec[idx] += count / tokens.length; // TF
  }

  // Normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag > 0) { for (let i = 0; i < vec.length; i++) vec[i] /= mag; }
  return vec;
}
