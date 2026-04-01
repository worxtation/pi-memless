/**
 * Rule-based compression engine — zero LLM, zero cost.
 *
 * Strategies:
 *   code_structure       → signatures only          (70–90% reduction)
 *   conversation_summary → key points only          (80–95% reduction)
 *   semantic_dedup       → remove duplicate lines   (50–70% reduction)
 *   hierarchical         → headers + first paragraph(60–80% reduction)
 */

export type CompressionStrategy =
  | "code_structure"
  | "conversation_summary"
  | "semantic_dedup"
  | "hierarchical";

export interface CompressionResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  strategy: CompressionStrategy;
}

// Rough token estimate: 4 chars ≈ 1 token
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function compress(content: string, strategy: CompressionStrategy = "code_structure"): CompressionResult {
  const originalTokens = estimateTokens(content);

  let compressed: string;
  switch (strategy) {
    case "code_structure":       compressed = compressCodeStructure(content); break;
    case "conversation_summary": compressed = compressConversation(content);  break;
    case "semantic_dedup":       compressed = deduplicateContent(content);    break;
    case "hierarchical":         compressed = compressHierarchical(content);  break;
    default:                     compressed = content;
  }

  const compressedTokens = estimateTokens(compressed);
  const ratio = originalTokens > 0
    ? 1 - (compressedTokens / originalTokens)
    : 0;

  return { compressed, originalTokens, compressedTokens, ratio, strategy };
}

// ──────────────────────────────────────────────────────────────────
// code_structure: keep imports, interfaces, class/fn signatures
// ──────────────────────────────────────────────────────────────────
function compressCodeStructure(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];

  let braceDepth = 0;
  let inBlockBody = false;   // inside a class/function body (depth > 0)
  let lastWasBlank = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // Skip truly blank lines when compressing
    if (!trimmed) {
      if (!lastWasBlank) out.push("");
      lastWasBlank = true;
      continue;
    }
    lastWasBlank = false;

    // Always keep: imports, exports (type decls), decorators, type aliases
    if (
      /^(import|export\s+(type\s+)?\{|export\s+(default\s+)?class|export\s+(default\s+)?function|export\s+(default\s+)?interface|export\s+(default\s+)?type|export\s+(default\s+)?enum|export\s+const\s+\w+\s*[:=])/.test(trimmed) ||
      /^@\w+/.test(trimmed)
    ) {
      // For export statements with bodies, keep only the signature line
      const sigLine = line.split("{")[0].replace(/\/\/.*$/, "").trimEnd();
      out.push(sigLine);
      braceDepth += countChar(line, "{") - countChar(line, "}");
      inBlockBody = braceDepth > 0;
      continue;
    }

    // Track brace depth
    const open = countChar(line, "{");
    const close = countChar(line, "}");

    // Interface / class / function declarations at depth-0
    if (braceDepth === 0 && (
      /\b(interface|class|function|type|enum|const|let|var)\b/.test(trimmed) ||
      /^(public|private|protected|static|async|abstract)\b/.test(trimmed) ||
      /^\w[\w<>, ]*\s*\(/.test(trimmed)   // method signature
    )) {
      const sig = line.split("{")[0].replace(/\/\/.*$/, "").trimEnd();
      out.push(sig);
      braceDepth += open - close;
      inBlockBody = braceDepth > 0;
      continue;
    }

    // Closing brace at depth 1 (end of block)
    if (braceDepth === 1 && trimmed === "}") {
      out.push("}");
      braceDepth = 0;
      inBlockBody = false;
      continue;
    }

    // Inside block body: keep only JSDoc, decorator lines, and method signatures
    if (inBlockBody && braceDepth === 1) {
      if (/^\/\*\*|^\*|^@\w+/.test(trimmed)) {
        out.push(line);
      } else if (
        /^(public|private|protected|static|async|abstract|get |set |\w+\s*\()/.test(trimmed) &&
        !trimmed.startsWith("//")
      ) {
        const sig = line.split("{")[0].replace(/\/\/.*$/, "").trimEnd();
        out.push("  " + sig.trim());
      }
      braceDepth += open - close;
      continue;
    }

    braceDepth += open - close;
    braceDepth = Math.max(0, braceDepth);
    inBlockBody = braceDepth > 0;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function countChar(str: string, char: string): number {
  let n = 0;
  for (const c of str) if (c === char) n++;
  return n;
}

// ──────────────────────────────────────────────────────────────────
// conversation_summary: extract key decisions + action lines
// ──────────────────────────────────────────────────────────────────
const DECISION_KEYWORDS = /\b(decided|decision|chose|chosen|will use|agreed|must|should|cannot|need to|going to|plan to|resolved|fixed|implemented|created|added|removed|updated|changed|migrated|refactored)\b/i;
const QUESTION_KEYWORDS = /\b(why|how|what|when|where|todo|fixme|note:|warning:|error:|issue:|bug:|TODO|FIXME)\b/;
const HEADING_RE = /^(#{1,6}\s|\*\*[^*]+\*\*|[A-Z][^a-z]{3,}:)/;

function compressConversation(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  const total = lines.length;
  const keepFirst = Math.min(8, Math.floor(total * 0.1));
  const keepLast  = Math.min(8, Math.floor(total * 0.1));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;

    // Always keep first/last N lines
    if (i < keepFirst || i >= total - keepLast) {
      out.push(line);
      continue;
    }

    // Keep decision/action lines
    if (DECISION_KEYWORDS.test(t) || QUESTION_KEYWORDS.test(t) || HEADING_RE.test(t)) {
      out.push(line);
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ──────────────────────────────────────────────────────────────────
// semantic_dedup: remove structurally duplicate lines
// ──────────────────────────────────────────────────────────────────
function deduplicateContent(content: string): string {
  const lines = content.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const normalized = line.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized) { out.push(line); continue; }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(line);
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ──────────────────────────────────────────────────────────────────
// hierarchical: keep headers + first paragraph of each section
// ──────────────────────────────────────────────────────────────────
function compressHierarchical(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inSection = false;
  let sectionLines = 0;
  const MAX_SECTION_LINES = 4;

  for (const line of lines) {
    const t = line.trim();

    if (/^#{1,6}\s/.test(t)) {
      // New section header
      out.push(line);
      inSection = true;
      sectionLines = 0;
      continue;
    }

    if (!t) {
      if (inSection) sectionLines++;
      if (sectionLines >= MAX_SECTION_LINES) inSection = false;
      out.push("");
      continue;
    }

    if (inSection && sectionLines < MAX_SECTION_LINES) {
      out.push(line);
      sectionLines++;
    } else if (!inSection) {
      // Outside any section — keep as is
      out.push(line);
    }
    // else: inside section but past limit → skip
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
