import { readFileSync, writeFileSync } from "fs";

const path = new URL("../extensions/memless/index.ts", import.meta.url).pathname
  .replace(/^\/([A-Z]:)/, "$1");

let d = readFileSync(path, "utf8");

const injection = `// ── T2.3: progress polling durante indexação ────────────────────────────
async function startIndexWithProgress(ctx: any) {
  try {
    const resp = await api<any>("POST", "/api/index", { projectPath, projectId });
    indexJobId = resp.data?.jobId ?? "";
    if (!indexJobId) { ctx.ui.setStatus("memless", "● ready"); return; }
    const poll = async () => {
      try {
        const s = await api<any>("GET", \`/api/index/status/\${indexJobId}\`);
        const d = s.data;
        if (d.status === "running") {
          const pct = d.progressTotal > 0
            ? Math.round((d.progressCurrent / d.progressTotal) * 100) : 0;
          ctx.ui.setStatus("memless", \`indexing \${d.progressCurrent}/\${d.progressTotal} (\${pct}%)\`);
          setTimeout(poll, 1500);
        } else if (d.status === "completed") {
          ctx.ui.setStatus("memless", \`● ready — \${d.filesIndexed} files, \${d.chunksIndexed} chunks\`);
          setTimeout(() => ctx.ui.setStatus("memless", "● ready"), 5000);
        } else {
          ctx.ui.setStatus("memless", "● ready");
        }
      } catch { ctx.ui.setStatus("memless", "● ready"); }
    };
    setTimeout(poll, 800);
  } catch (e) {
    ctx.ui.notify(\`[memless] index error: \${e}\`, "warning");
    ctx.ui.setStatus("memless", "● ready");
  }
}

`;

const markerIdx = d.indexOf("// Extension entry point");
if (markerIdx === -1) { console.error("marker not found"); process.exit(1); }

// Não re-injetar se já existe
if (d.includes("startIndexWithProgress")) {
  console.log("already injected, skipping");
  process.exit(0);
}

d = d.slice(0, markerIdx) + injection + d.slice(markerIdx);
writeFileSync(path, d, "utf8");
console.log("OK — injected startIndexWithProgress");
