# pi-memless — Plano de Execução de Melhorias

> **Objetivo principal:** máxima economia de tokens enviados ao LLM + melhor UX via hooks Pi + dashboard browser para observabilidade  
> **Critério de prioridade:** impacto × facilidade × tokens economizados por sessão  
> **Legenda de status:** `[ ]` pendente · `[~]` em progresso · `[x]` concluído

---

## Visão Rápida — Progresso Geral

```
Fase 1 — Token Economy (bugs reais)        [x] [x] [x] [x]     4/4 ✅
Fase 2 — Hooks & UX                        [x] [x] [x] [ ]     3/4
Fase 3 — Remoção de Ruído                  [x] [x] [x] [x]     4/4 ✅
Fase 4 — Ferramentas Novas                 [x] [x] [x]         3/3 ✅
Fase 5 — Dashboard Browser                 [x] [x]             2/2 ✅
Fase 6 — Arquitetura (médio prazo)         [ ] [ ] [ ]         0/3
```

---

## Fase 1 — Token Economy (bugs que desperdiçam tokens agora)

> Foco: corrigir onde tokens são desperdiçados sem retorno. Sem essas correções,
> a proposta central do memless não se sustenta.

---

### T1.1 — `memless_context`: compressão nunca dispara, `tokensSaved` sempre 0
**Status:** `[x]` commit `0f2304d`  
**Arquivos:** `server/src/index.ts` (rota `/api/context/optimized`)  
**Custo:** ~30 min  
**Impacto:** corrige a métrica principal do memless; a compressão passa a acontecer de verdade

**Problema:**
```ts
// ❌ ATUAL — summary já trunca para 6 linhas → codeToks fica ~80, nunca > codeBudget (3200)
const codeResults = await searchProject({ ..., responseMode: "summary" });
// ...
const codeToks = estimateTokens(rawCode); // ~80 tokens
if (codeToks > codeBudget) {              // NUNCA entra aqui
  compress(...)
}
const tokensSaved = ...; // sempre 0
```

**Fix:**
```ts
// ✅ NOVO — buscar full, comprimir para caber no budget, reportar economia real
const codeResults = await searchProject({ ..., responseMode: "full" });
// ...
const rawCode   = codeSection;
const rawToks   = estimateTokens(rawCode);       // tokens reais antes da compressão
const memToks   = estimateTokens(memSection);

if (rawToks > codeBudget) {
  const result  = doCompress(rawCode, "code_structure");
  codeSection   = result.compressed;
} else if (rawToks + memToks > maxTokens) {
  // mesmo sem compressão total, truncar se necessário
  codeSection   = rawCode.split("\n").slice(0, codeBudget * 4).join("\n");
}

const tokensSaved = rawToks - estimateTokens(codeSection); // economia real
```

**Validação:** chamar `memless_context` → header deve mostrar `tokensSaved > 0` quando há código retornado.

---

### T1.2 — Cache L2 (cross-session) nunca tem hits por causa do `sessionId` na chave
**Status:** `[x]` commit `0f2304d`  
**Arquivos:** `server/src/index.ts` (rota `/api/context/optimized`)  
**Custo:** 15 min  
**Impacto:** L2 cache passa a funcionar entre sessões — queries recorrentes na mesma semana não re-executam busca+compressão

**Problema:**
```ts
// ❌ ATUAL — sessionId = "pi-1712345678", muda a cada start
const cacheKey = `optctx:${sessionId ?? ""}:${projectId}:${query}`;
// L2 tem TTL 1h mas nunca é acessado cross-session → espaço desperdiçado
```

**Fix:**
```ts
// ✅ NOVO — chave sem sessionId; TTL 1h no L2 ainda evita resultados stale
const cacheKey   = `optctx:${projectId}:${hashQuery(query)}`;
// sessionId vai só para analytics/log, nunca para a chave de cache

function hashQuery(q: string): string {
  // hash simples djb2 para não ter query longa na chave
  let h = 5381;
  for (let i = 0; i < q.length; i++) h = ((h << 5) + h) ^ q.charCodeAt(i);
  return (h >>> 0).toString(36);
}
```

**Validação:** iniciar duas sessões Pi diferentes, chamar `memless_context` com a mesma query → segunda vez deve mostrar `cacheHit: true`.

---

### T1.3 — `isServerRunning()` em cada ferramenta — 1 fetch `/health` extra por tool call
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts`  
**Custo:** 1h  
**Impacto:** elimina até 9 roundtrips HTTP extras por sessão (1 por ferramenta chamada); reduz latência percebida

**Problema:**
```ts
// ❌ ATUAL — cada uma das 9 ferramentas faz fetch /health antes de executar
async execute(_id, params, ...) {
  if (!await isServerRunning())   // ← fetch com timeout 1.5s
    return { content: [{ type: "text", text: "memless server not running" }] };
  // ...
}
```

**Fix — health state cacheado com TTL:**
```ts
// ── Adicionar no topo da extensão (junto com as outras variáveis de estado) ──
let _serverHealthy = false;
let _lastHealthCheck = 0;
const HEALTH_CACHE_MS = 45_000; // 45s — curto o suficiente para detectar crash

async function checkServer(): Promise<boolean> {
  const now = Date.now();
  if (_serverHealthy && now - _lastHealthCheck < HEALTH_CACHE_MS) return true;
  const ok = await isServerRunning();
  _serverHealthy = ok;
  _lastHealthCheck = now;
  return ok;
}

// ── Em todos os tools: trocar isServerRunning() por checkServer() ──
// ── No session_start: setar _serverHealthy = true após ensureServer() ──
// ── No session_shutdown: setar _serverHealthy = false ──
```

**Validação:** logar tempo de execução de `memless_search` antes/depois — deve cair ~1.5s na latência.

---

### T1.4 — `memless_compress`: sem threshold mínimo — roundtrip HTTP para conteúdo tiny
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts` (tool `memless_compress`)  
**Custo:** 20 min  
**Impacto:** evita custo de rede para compressões inúteis (<200 tokens já são minúsculos)

**Problema:**
```ts
// ❌ ATUAL — faz POST /api/compress mesmo para um snippet de 50 tokens
async execute(_id, params) {
  const resp = await api("POST", "/api/compress", params);
```

**Fix — short-circuit local:**
```ts
async execute(_id, params) {
  const tokenEstimate = Math.ceil((params.content ?? "").length / 4);
  if (tokenEstimate < 200) {
    return {
      content: [{ type: "text", text: `<!-- memless: content too small to compress (${tokenEstimate} tokens est.) -->\n\n${params.content}` }],
      details: { skipped: true, originalTokens: tokenEstimate, tokensSaved: 0 },
    };
  }
  const resp = await api("POST", "/api/compress", params);
  // ...
```

**Validação:** chamar `memless_compress` com um snippet curto → resposta imediata sem hit no servidor.

---

## Fase 2 — Hooks & UX (melhorar o que o agente sente, não apenas o que computa)

> Foco: usar os hooks do Pi para que o agente **receba** contexto no momento certo,
> **veja** progresso em tempo real, e **não faça** work desnecessário.

---

### T2.1 — `before_agent_start`: recall seletivo — não injetar em prompts triviais
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts`  
**Custo:** 45 min  
**Impacto:** elimina o bloco de memórias no contexto para ~40% dos prompts (comandos rápidos, oneliners)

**Problema:**
```ts
// ❌ ATUAL — injeta memórias mesmo para "ls ." ou "run npm test"
pi.on("before_agent_start", async (event, ctx) => {
  if (initialRecallDone ...) return;
  initialRecallDone = true;
  // → sempre injeta bloco de memórias, independente do prompt
```

**Fix — heurística de substancialidade:**
```ts
pi.on("before_agent_start", async (event, ctx) => {
  if (initialRecallDone || !projectId || !await checkServer()) return;
  initialRecallDone = true;

  const prompt = (event.prompt ?? "").trim();

  // Heurística: prompt trivial → sem injeção de memórias
  const isTrivial =
    prompt.length < 35 ||                                          // muito curto
    /^(ls|pwd|cd |cat |run |npm |bun |git |echo )/i.test(prompt) || // comando shell
    /^(ok|yes|no|sure|thanks|done|got it)/i.test(prompt);          // ack curto

  if (isTrivial) return; // não injetar, economizar tokens

  // Ajustar query de recall ao prompt real (mais relevante)
  const recallQuery = prompt.length > 10
    ? prompt.slice(0, 120)
    : "project decisions patterns architecture";

  const resp = await api<any>("POST", "/api/memory/search", {
    query: recallQuery,  // ← antes era sempre hardcoded
    // ...
  });
  // ...
});
```

**Validação:** prompt curto → sem bloco `## memless: recalled context`; prompt longo sobre feature → bloco aparece.

---

### T2.2 — `session_before_compact`: auto-extrair decisões para memórias (hook de ouro)
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts`  
**Custo:** 2h  
**Impacto:** cada compaction passa a persistir automaticamente decisões-chave sem o agente precisar chamar `memless_remember` — memória cresce organicamente

**O que fazer:**
```ts
pi.on("session_before_compact", async (event, ctx) => {
  // ... compressão existente (manter) ...

  // ✅ NOVO — após comprimir, extrair decisões e salvar como memórias
  try {
    const DECISION_RE = /\b(decided|will use|fixed|implemented|chose|must|going to|resolved|refactored|added|changed)\b/i;
    const lines = conversationText.split("\n");

    const candidates = lines.filter(l => {
      const t = l.trim();
      return t.length > 40 && t.length < 400 && DECISION_RE.test(t);
    });

    // Top 5 linhas mais "densas" (heurística: mais substantivos únicos)
    const top = candidates
      .map(l => ({ line: l, score: new Set(l.toLowerCase().match(/\b\w{4,}\b/g) ?? []).size }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    for (const { line } of top) {
      await api("POST", "/api/memory/store", {
        content:    line.trim(),
        type:       "decision",
        projectId,
        sessionId,
        importance: 0.55,
        tags:       ["auto-compact", "extracted"],
      });
    }

    if (top.length > 0) {
      ctx.ui.notify(`[memless] auto-saved ${top.length} decisions from compaction`, "info");
    }
  } catch {}
  // ...
});
```

**Validação:** após uma sessão longa → chamar `memless_recall` → deve retornar memórias tagged `auto-compact`.

---

### T2.3 — Status bar: mostrar progresso de indexação em tempo real
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts`  
**Custo:** 1.5h  
**Impacto:** o agente sabe quando pode buscar com confiança; elimina buscas silenciosamente vazias durante indexação inicial

**O que fazer:**
```ts
// ── Substituir o fire-and-forget por poll ──
async function startIndexAndPoll(ctx: any) {
  try {
    const resp = await api<any>("POST", "/api/index", { projectPath, projectId });
    indexJobId = resp.data?.jobId ?? "";

    if (!indexJobId) return;

    // Poll até completar, atualizando status bar
    const poll = async () => {
      try {
        const s = await api<any>("GET", `/api/index/status/${indexJobId}`);
        const d = s.data;
        if (d.status === "running") {
          const pct = d.progressTotal > 0
            ? Math.round((d.progressCurrent / d.progressTotal) * 100)
            : 0;
          ctx.ui.setStatus("memless", `indexing ${d.progressCurrent}/${d.progressTotal} (${pct}%)`);
          setTimeout(poll, 1500);
        } else if (d.status === "completed") {
          ctx.ui.setStatus("memless", `● ready — ${d.filesIndexed} files, ${d.chunksIndexed} chunks`);
          setTimeout(() => ctx.ui.setStatus("memless", "● ready"), 4000);
        } else {
          ctx.ui.setStatus("memless", "● ready");
        }
      } catch {
        ctx.ui.setStatus("memless", "● ready");
      }
    };
    setTimeout(poll, 1000);
  } catch (e) {
    ctx.ui.notify(`[memless] index error: ${e}`, "warning");
  }
}

// No session_start: substituir o bloco de index por:
await startIndexAndPoll(ctx);
```

**Validação:** abrir Pi em projeto grande → status bar mostra `indexing 12/87 (14%)` e progride até `● ready — 87 files, 320 chunks`.

---

### T2.4 — `before_tool_call` hook: avisar quando index está stale antes de busca
**Status:** `[ ]` pendente — verificar se Pi SDK expe before_tool_call  
**Arquivos:** `extensions/memless/index.ts`  
**Custo:** 1h  
**Impacto:** o agente recebe alerta proativo quando vai buscar em índice desatualizado — evita confusão com resultados incompletos

**O que fazer:**
```ts
// ── Adicionar hook before_tool_call ──
pi.on("before_tool_call", async (event, ctx) => {
  // Só para ferramentas de busca
  if (!["memless_search", "memless_context"].includes(event.toolName)) return;

  // Verificar se índice está stale (sem re-fetch se já verificado recentemente)
  if (Date.now() - lastStalenessCheck < 60_000) return;
  lastStalenessCheck = Date.now();

  try {
    const resp = await api<any>("POST", "/api/search", {
      query: "__stale_check__", projectId, maxResults: 1
    });
    if (resp.meta?.stale) {
      ctx.ui.notify(
        `[memless] index is stale (>24h) — results may be incomplete. Run memless_index to refresh.`,
        "warning"
      );
    }
  } catch {}
});

let lastStalenessCheck = 0;
```

> **Nota:** verificar se o Pi SDK expõe `before_tool_call`. Se não expor ainda,
> fazer a verificação no início do `execute` de `memless_search` e `memless_context`
> com a mesma lógica de cache de 60s.

**Validação:** forçar staleAfterMs baixo no config → chamar `memless_search` → warning aparece.

---

## Fase 3 — Remoção de Ruído (o que não agrega, polui contexto ou banco)

> Foco: remover código que gera tokens inúteis, entradas desnecessárias no banco,
> ou cria falsas expectativas.

---

### T3.1 — `session_shutdown`: remover nota inútil de sessão
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts`  
**Custo:** 20 min  
**Impacto:** elimina ~1 memória inútil por sessão que polui recall e consome importance budget

**Problema:**
```ts
// ❌ ATUAL — salva "Session 2026-04-01 in 'pi-memless' at Z:\..." toda sessão
// Isso não ensina nada, nunca é útil no recall, e ocupa espaço
await api("POST", "/api/memory/store", {
  content: `Session ${new Date().toISOString().slice(0, 10)} in "${projectId}" at ${projectPath}`,
  type: "conversation",
  importance: 0.35,
```

**Fix:**
```ts
// ✅ NOVO — só salvar se houve atividade real (tool calls) E incluir o que foi feito
pi.on("session_shutdown", async () => {
  // toolCallCount é incrementado em cada execute() das tools
  if (!projectId || !_serverHealthy || toolCallCount === 0) return;

  // Só salvar se foi uma sessão de trabalho real (> 3 tool calls)
  if (toolCallCount < 3) return;

  try {
    await api("POST", "/api/memory/store", {
      content: `Worked on "${projectId}" — ${toolCallCount} tool calls on ${new Date().toISOString().slice(0, 10)}`,
      type:       "conversation",
      projectId,
      sessionId,
      importance: 0.25,  // importância mínima — decai rápido e some
      tags:       ["session-summary", "auto"],
    });
  } catch {}
});

// ── Adicionar contador no topo da extensão ──
let toolCallCount = 0;
// ── Em cada tool execute(): toolCallCount++ ──
```

---

### T3.2 — `semantic_dedup`: renomear strategy para `line_dedup` (documentação honesta)
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `server/src/compression.ts`, `extensions/memless/index.ts`, `AGENTS.md`, `skills/memless/SKILL.md`  
**Custo:** 30 min  
**Impacto:** evita que o agente confie em "deduplicação semântica" que na prática só remove linhas exatas — previne estratégia errada de compressão

**Fix:**
```ts
// server/src/compression.ts
export type CompressionStrategy =
  | "code_structure"
  | "conversation_summary"
  | "line_dedup"          // ← era "semantic_dedup"
  | "hierarchical";

// extensions/memless/index.ts — no Type.Literal da tool:
Type.Literal("line_dedup")  // ← atualizar descrição: "remove duplicate lines (30-50%)"

// AGENTS.md e SKILL.md — atualizar tabela de estratégias
```

> **Nota:** manter `"semantic_dedup"` como alias no server para não quebrar chamadas existentes,
> mas deprecar na documentação.

---

### T3.3 — `memless_recall`: truncar conteúdo longo de memórias no output
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts` (tool `memless_recall`)  
**Custo:** 15 min  
**Impacto:** previne recall de explodir o contexto com uma única memória longa (ex: trecho de código armazenado inteiro); economiza tokens diretos

**Problema:**
```ts
// ❌ ATUAL — content verbatim, sem limite
const text = memories.map(m =>
  `[${m.type} | imp: ${m.importance?.toFixed(2)} | ...]\n${m.content}\ntags: ${(m.tags ?? []).join(", ")}`
).join("\n\n");
// Uma memória de 3000 chars = ~750 tokens por item, × 10 = 7500 tokens
```

**Fix:**
```ts
// ✅ NOVO — truncar a 500 chars, mostrar score e link de expansão
const MAX_CONTENT = 500;
const text = memories.map(m => {
  const snip  = m.content.length > MAX_CONTENT
    ? m.content.slice(0, MAX_CONTENT - 3) + "…"
    : m.content;
  const decay = m.importance != null && m.importance < 0.4 ? " ⚠️stale" : "";
  return `[${m.type} | imp: ${m.importance?.toFixed(2)}${decay} | ${new Date(m.createdAt * 1000).toISOString().slice(0, 10)}]\n${snip}`;
}).join("\n\n");
// tags removidas do output padrão — só poluem; disponíveis em details
```

---

### T3.4 — Silenciar logs de ruído do servidor (`consolidation`, `background jobs`)
**Status:** `[x]` commit `0f2304d`  
**Arquivos:** `server/src/jobs.ts`, `server/src/index.ts`, `server/src/embeddings.ts`  
**Custo:** 20 min  
**Impacto:** elimina spam no stderr como `[memless] consolidation: +0 promoted, 8 decayed, 0 pruned` que aparece a cada 5 min sem dizer nada útil; terminal fica limpo

**Problema — logs sempre ligados, mesmo quando vazios:**
```ts
// jobs.ts — imprime MESMO quando não há nada relevante
console.error(`[memless] background jobs started (interval: ${intervalMs / 1000}s)`);
// ...
if (promoted + decayed + pruned > 0) {   // ← só esse bloco tem guard
  console.error(`[memless] consolidation: +${promoted} promoted, ${decayed} decayed, ${pruned} pruned`);
}
// embeddings.ts — printa provider toda vez que detecta
console.error("[memless] embeddings: ollama");
// index.ts
console.error(`[memless] server running on http://localhost:${server.port}`);
```

**Fix — nível de log configurável via env `MEMLESS_LOG`:**
```ts
// config.ts — adicionar
export const LOG_LEVEL: "silent" | "error" | "info" | "debug" =
  (process.env.MEMLESS_LOG as any) ?? "error";

// logger.ts — novo arquivo minimalista
import { LOG_LEVEL } from "./config.ts";
const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };
export const log = {
  error: (msg: string) => LEVELS[LOG_LEVEL] >= 1 && console.error(`[memless] ${msg}`),
  info:  (msg: string) => LEVELS[LOG_LEVEL] >= 2 && console.error(`[memless] ${msg}`),
  debug: (msg: string) => LEVELS[LOG_LEVEL] >= 3 && console.error(`[memless] ${msg}`),
};

// jobs.ts — substituir console.error por:
log.info(`background jobs started (interval: ${intervalMs / 1000}s)`);
// consolidation: só logar se algo mudou E se level >= info
if (promoted + pruned > 0)  // decayed sozinho não é interessante
  log.info(`consolidation: +${promoted} promoted, ${pruned} pruned`);

// embeddings.ts
log.info(`embeddings: ${_provider}`);

// index.ts
log.error(`server running on http://localhost:${server.port}`); // esse fica (error = sempre)
```

**Default:** `MEMLESS_LOG=error` → só o `server running on port` aparece. Passar `MEMLESS_LOG=info` para debug quando necessário.

**Na extensão** — ao spawnar o servidor:
```ts
serverProcess = spawn(bun, ["src/index.ts"], {
  env: { ...process.env, MEMLESS_PORT: String(MEMLESS_PORT), MEMLESS_LOG: "error" },
  // ...
});
```

**Validação:** iniciar Pi → nenhum log de consolidation aparece no terminal após 5 min; `MEMLESS_LOG=info bun src/index.ts` → logs voltam.

---

## Fase 4 — Ferramentas Novas (funcionalidade que falta)

---

### T4.1 — Adicionar `memless_forget` — deletar/corrigir memórias erradas
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts`, `server/src/index.ts`, `server/src/memory.ts`  
**Custo:** 3h  
**Impacto:** memórias erradas são corrigíveis; hoje são permanentes por 45 dias

**Server — nova rota:**
```ts
// DELETE /api/memory/:id
route("DELETE", /^\/api\/memory\/([^/]+)$/, async (_req, url) => {
  const id = url.pathname.split("/").pop()!;
  const db = getDb();
  db.run("DELETE FROM memories_fts WHERE memory_id=?", [id]);
  db.run("DELETE FROM memory_edges WHERE source_id=? OR target_id=?", [id, id]);
  const result = db.run("DELETE FROM memories WHERE id=?", [id]);
  if (result.changes === 0) return err("Memory not found", 404);
  return json({ success: true, deleted: id });
});
```

**Extension — nova tool:**
```ts
pi.registerTool({
  name: "memless_forget",
  label: "memless: delete memory",
  description: "Delete a wrong or outdated memory by ID. Get the ID from memless_recall output.",
  parameters: Type.Object({
    memoryId: Type.String({ description: "Memory ID (e.g. mem_1712345678_abc123) from recall output" }),
  }),
  async execute(_id, params) {
    if (!await checkServer()) return { content: [{ type: "text", text: "server not running" }], details: {} };
    await api("DELETE", `/api/memory/${params.memoryId}`);
    return {
      content: [{ type: "text", text: `✓ Memory ${params.memoryId} deleted` }],
      details: { deleted: params.memoryId },
    };
  },
});
```

**Validação:** `memless_recall` → pegar ID → `memless_forget` com ID → `memless_recall` de novo → não aparece mais.

---

### T4.2 — Deduplicação no `memless_remember` — não criar memórias redundantes
**Status:** `[x]` commit `49666a7`  
**Arquivos:** `server/src/memory.ts` (função `storeMemory`)  
**Custo:** 2h  
**Impacto:** previne banco de memórias crescer com duplicatas semânticas; recall retorna informação mais densa

**Fix no servidor — pre-check de similaridade:**
```ts
export async function storeMemory(params: StoreParams): Promise<Memory & { deduplicated?: boolean }> {
  // ── Deduplication check (antes do INSERT) ──
  if (params.type !== "conversation") { // só para types que persistem
    try {
      const similar = await searchMemories({
        query: params.content,
        projectId: params.projectId,
        limit: 3,
        minImportance: 0.2,
        types: [params.type],
      });

      for (const candidate of similar) {
        // Verificar similaridade semântica alta (se embedding disponível)
        const sim = candidate.score ?? 0;
        if (sim > 0.45) { // threshold RRF alto = muito similar
          // Reforçar a memória existente ao invés de duplicar
          db.run(
            "UPDATE memories SET importance=MIN(1.0, importance + 0.1), access_count=access_count+1 WHERE id=?",
            [candidate.id]
          );
          return { ...candidate, deduplicated: true };
        }
      }
    } catch {}
  }

  // ... INSERT normal ...
}
```

**No extension — tool `memless_remember`:**
```ts
// Adaptar output para indicar deduplicação
if (resp.data?.deduplicated) {
  return {
    content: [{ type: "text", text: `↑ Similar memory reinforced (id: ${resp.data.id}) — importance +0.1` }],
    details: resp.data,
  };
}
```

**Validação:** chamar `memless_remember` duas vezes com conteúdo similar → segunda vez retorna `↑ Similar memory reinforced`.

---

### T4.3 — `memless_context`: expor `responseMode` ao agente
**Status:** `[x]` commit `0f6d1f3`  
**Arquivos:** `extensions/memless/index.ts` (tool `memless_context`)  
**Custo:** 30 min  
**Impacto:** agente pode pedir contexto "full" quando precisa ver código completo, ou "summary" quando quer só orientação — controle explícito de tokens

**Fix:**
```ts
pi.registerTool({
  name: "memless_context",
  parameters: Type.Object({
    // ... params existentes ...
    responseMode: Type.Optional(Type.Union([
      Type.Literal("summary"),
      Type.Literal("full"),
    ], { description: "summary=compressed snippets (default, saves tokens), full=complete file sections" })),
  }),
  async execute(_id, params, ...) {
    const resp = await api("POST", "/api/context/optimized", {
      maxTokens: 4000, maxResults: 5, includeMemories: true, memoryBudgetRatio: 0.2,
      ...params,
      // ← responseMode agora passado ao servidor
      projectId: pid,
      sessionId,
    });
    // ...
  }
});

// No servidor, usar params.responseMode no searchProject interno
```

---

## Fase 5 — Dashboard Browser (observabilidade sem poluir o terminal)

> Foco: uma UI web leve servida pelo próprio servidor memless na porta 3434,
> acessível em `http://localhost:3434` — sem dependências externas, sem bundler,
> HTML+JS vanilla ou Preact via CDN.

---

### T5.1 — Servidor: rota `GET /` → dashboard HTML com dados em tempo real
**Status:** `[x]` commit `34e5d32`  
**Arquivos:** `server/src/index.ts`, `server/src/dashboard.ts` (novo)  
**Custo:** 4h  
**Impacto:** visibilidade completa do estado do memless sem terminal — memórias, cache, buscas, jobs de indexação, tudo em um browser; elimina a necessidade de `memless_analytics` para inspeção humana

**Páginas / seções do dashboard:**

| Seção | Dados mostrados | Rota de dados |
|---|---|---|
| **Status** | provider, uptime, porta, versão | `GET /health` |
| **Memórias** | lista paginada, filtro por tipo/projeto, importância, botão delete | `POST /api/memory/search` |
| **Índice** | projetos indexados, files/chunks, stale?, último index | `GET /api/analytics` |
| **Jobs** | jobs ativos e recentes com barra de progresso live | `GET /api/index/status/:id` |
| **Cache** | L1 size, L2 size, hit rate estimado | `GET /api/cache/stats` |
| **Buscas** | top queries, avg latência, total | `GET /api/analytics?type=summary` |

**Estrutura do código:**
```ts
// server/src/dashboard.ts — gera o HTML completo
export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>memless dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, monospace; background: #0f0f11; color: #e2e2e2; padding: 2rem; }
    h1 { color: #a78bfa; margin-bottom: 1.5rem; font-size: 1.4rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 1rem; }
    .card { background: #1a1a1f; border: 1px solid #2e2e38; border-radius: 8px; padding: 1.2rem; }
    .card h2 { font-size: .85rem; color: #7c7c9a; text-transform: uppercase; letter-spacing: .08em; margin-bottom: .8rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: .75rem; }
    .badge-ok { background: #14532d; color: #4ade80; }
    .badge-warn { background: #451a03; color: #fb923c; }
    table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    th { color: #7c7c9a; text-align: left; padding: 4px 8px; border-bottom: 1px solid #2e2e38; }
    td { padding: 4px 8px; border-bottom: 1px solid #1e1e26; }
    .del-btn { background: #3f1111; color: #f87171; border: none; border-radius: 3px;
               padding: 2px 6px; cursor: pointer; font-size: .75rem; }
    .del-btn:hover { background: #7f1d1d; }
    .progress { height: 6px; background: #2e2e38; border-radius: 3px; margin-top: 6px; }
    .progress-bar { height: 100%; background: #a78bfa; border-radius: 3px; transition: width .3s; }
    #refresh-info { font-size: .75rem; color: #555; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>⚡ memless dashboard</h1>
  <p id="refresh-info">auto-refresh every 5s</p>
  <div class="grid" id="root">loading…</div>

  <script>
    const BASE = '';
    let deleteMemory = async (id) => {
      if (!confirm('Delete memory ' + id + '?')) return;
      await fetch(BASE + '/api/memory/' + id, { method: 'DELETE' });
      load();
    };

    async function load() {
      const [health, analytics, cache, memories] = await Promise.all([
        fetch(BASE + '/health').then(r => r.json()),
        fetch(BASE + '/api/analytics?type=summary').then(r => r.json()),
        fetch(BASE + '/api/cache/stats').then(r => r.json()),
        fetch(BASE + '/api/memory/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'project', limit: 20, minImportance: 0 })
        }).then(r => r.json()),
      ]);

      const h = health;
      const a = analytics?.data ?? {};
      const c = cache?.data ?? {};
      const mems = memories?.data ?? [];

      document.getElementById('root').innerHTML = [
        card('Status', `
          <table>
            <tr><th>server</th><td><span class="badge badge-ok">online :${h.port ?? 3434}</span></td></tr>
            <tr><th>embeddings</th><td>${h.provider}</td></tr>
            <tr><th>cache L1</th><td>${c.l1Size} entries</td></tr>
            <tr><th>cache L2</th><td>${c.l2Size} entries</td></tr>
          </table>
        `),
        card('Searches', `
          <table>
            <tr><th>total</th><td>${a.totalSearches ?? 0}</td></tr>
            <tr><th>avg latency</th><td>${a.avgDurationMs ?? 0} ms</td></tr>
          </table>
          <br>
          <table>
            <tr><th>query</th><th>count</th></tr>
            ${(a.topQueries ?? []).map(q => `<tr><td>${esc(q.query)}</td><td>${q.cnt}</td></tr>`).join('')}
          </table>
        `),
        card('Memories (' + mems.length + ')', `
          <table>
            <tr><th>type</th><th>imp</th><th>content</th><th></th></tr>
            ${mems.map(m => `
              <tr>
                <td>${m.type}</td>
                <td>${(m.importance ?? 0).toFixed(2)}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.content)}</td>
                <td><button class="del-btn" onclick="deleteMemory('${m.id}')">del</button></td>
              </tr>`).join('')}
          </table>
        `),
      ].join('');
    }

    function card(title, body) {
      return '<div class="card"><h2>' + title + '</h2>' + body + '</div>';
    }
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

// server/src/index.ts — adicionar rota:
route("GET", "/", async () => {
  const { renderDashboard } = await import("./dashboard.ts");
  return new Response(renderDashboard(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
```

**Comando `/memless` na extensão — adicionar link:**
```ts
ctx.ui.notify(
  [
    // ... linhas existentes ...
    ``,
    `dashboard: http://localhost:${MEMLESS_PORT}`,  // ← linha nova
  ].join("\n"),
  "info"
);
```

**Validação:** abrir `http://localhost:3434` no browser → dashboard carrega, mostra memórias reais, botão `del` deleta, dados atualizam a cada 5s.

---

### T5.2 — Dashboard: página de detalhes de memória + edição inline
**Status:** `[x]` commit `34e5d32`  
**Arquivos:** `server/src/dashboard.ts`, `server/src/index.ts`  
**Custo:** 2h  
**Dependência:** T5.1 concluído  
**Impacto:** permite inspecionar e corrigir memórias diretamente no browser sem precisar de `memless_forget` via LLM — gestão humana direta do banco de conhecimento

**O que adicionar:**
- Rota `GET /api/memory/:id` → retorna memória completa (content sem truncate)
- Rota `PATCH /api/memory/:id` → atualiza `content`, `importance`, `tags`
- No dashboard: clicar numa linha de memória abre modal com content completo + campo de edição
- Slider de importância editável
- Filtros por projeto, tipo e faixa de importância no topo da tabela de memórias

**Validação:** abrir dashboard → clicar em memória → editar conteúdo → salvar → `memless_recall` retorna o conteúdo atualizado.

---

## Fase 6 — Arquitetura (médio prazo, maior esforço)

> Estas tarefas exigem mudanças mais profundas. Deixar para depois das fases 1–4.

---

### T6.1 — Vector search: eliminar full table scan com `sqlite-vec`
**Status:** `[ ]` pendente  
**Arquivos:** `server/src/search.ts`, `server/src/memory.ts`, `server/src/db.ts`  
**Custo:** 1 dia  
**Impacto:** em projetos com 5.000+ chunks, a busca atual carrega ~30MB de JSON na memória. Com sqlite-vec, a busca vetorial fica no SQLite nativo.

**Referência:** https://github.com/asg017/sqlite-vec  
**Resumo do que mudar:**
- `db.ts`: carregar extensão sqlite-vec, criar virtual tables `chunks_vec` e `memories_vec`
- `search.ts`: substituir query manual de cosine por `SELECT ... FROM chunks_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
- `memory.ts`: idem para memórias
- Manter fallback para TF-IDF quando sqlite-vec não disponível

---

### T6.2 — `compressCodeStructure`: corrigir contagem de `{` em strings
**Status:** `[ ]` pendente  
**Arquivos:** `server/src/compression.ts`  
**Custo:** 3h  
**Impacto:** compressão de código com template literals / strings com `{` deixa de produzir resultados incorretos

**Referência de fix:** seção T1.x da análise — implementar `countBraces()` que ignora conteúdo de strings.

---

### T6.3 — `collectFiles`: respeitar `.gitignore`
**Status:** `[ ]` pendente  
**Arquivos:** `server/src/search.ts`  
**Custo:** 2h  
**Impacto:** projetos com `.gitignore` não terão arquivos de build/dist indexados, reduzindo ruído nas buscas e tamanho do índice

**Resumo do que mudar:**
```ts
// Em collectFiles(), ler .gitignore recursivamente por diretório
// Usar uma implementação mínima de glob matching (já existe minimatch local)
// Respeitar entradas negadas (!padrão) também
```

---

## Checklist de Validação Final

Após completar todas as fases, validar:

- [x] `memless_context` com código real → `tokensSaved > 0` no header
- [x] Segunda sessão com mesma query → `cacheHit: true` no header  
- [x] Prompt curto `"ls"` → nenhum bloco `## memless: recalled context` injetado
- [x] Prompt longo sobre feature → bloco de memórias injetado corretamente
- [x] Abrir Pi em projeto grande → status bar mostra progresso de indexação
- [x] `memless_forget` deleta memória → `memless_recall` não a retorna mais
- [x] `memless_remember` duas vezes com conteúdo similar → segundo reforça, não duplica
- [x] `session_before_compact` em sessão longa → auto-salva decisões tagged `auto-compact`
- [x] `memless_compress` com snippet <200 tokens → retorno imediato sem hit no servidor
- [x] Memória com 2000 chars → `memless_recall` trunca para 500 chars no output
- [x] Iniciar Pi → nenhum log de consolidation aparece a cada 5 min no terminal
- [x] `http://localhost:3434` → dashboard carrega com memórias, cache stats e top queries
- [x] Dashboard → botão `del` em memória → memória removida sem usar LLM
- [x] Comando `/memless` → exibe link `dashboard: http://localhost:3434`
- [ ] `before_tool_call` (T2.4) — pendente verificação do hook no Pi SDK

---

## Referências Rápidas

| Hook Pi usado | Onde | Para quê |
|---|---|---|
| `session_start` | extension | iniciar server, disparar indexação |
| `before_agent_start` | extension | injetar recall seletivo |
| `session_before_compact` | extension | comprimir + auto-extrair decisões |
| `session_shutdown` | extension | salvar nota (só se atividade real) |
| `before_tool_call` | extension (a implementar) | aviso de stale index |

| Arquivo | Responsabilidade |
|---|---|
| `extensions/memless/index.ts` | hooks Pi + registro de tools |
| `server/src/index.ts` | rotas REST |
| `server/src/search.ts` | indexação + busca híbrida |
| `server/src/memory.ts` | store + recall de memórias |
| `server/src/compression.ts` | engine de compressão rule-based |
| `server/src/cache.ts` | L1 (Map) + L2 (SQLite) cache |
| `server/src/jobs.ts` | decay + pruning + redundancy filter |
| `server/src/dashboard.ts` | HTML do dashboard browser (novo) |
| `server/src/logger.ts` | log level configurável via `MEMLESS_LOG` (novo) |

---

*Última atualização: 2026-04-01 (rev 3 — implementação completa F1–F5)*  
*Análise base: análise aprofundada registrada em memless (mem_1775016235682_26b74e)*
