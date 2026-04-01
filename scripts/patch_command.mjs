import { readFileSync, writeFileSync } from "fs";
const path = new URL("../extensions/memless/index.ts", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
let d = readFileSync(path, "utf8");

// Find the /memless command block start
const cmdStart = d.lastIndexOf("  // ── /memless command");
if (cmdStart === -1) { console.error("cmd marker not found"); process.exit(1); }

const forget = `  // ── T4.1: memless_forget ────────────────────────────────────────────
  pi.registerTool({
    name:        "memless_forget",
    label:       "memless: delete memory",
    description: "Delete a wrong or outdated memory by ID. Get the ID from memless_recall output.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "Memory ID (e.g. mem_1712345678_abc123) from recall output" }),
    }),
    async execute(_id, params) {
      toolCallCount++;
      if (!await checkServer())
        return { content: [{ type: "text", text: "memless server not running" }], details: {} };
      try {
        await api("DELETE", \`/api/memory/\${params.memoryId}\`);
        return {
          content: [{ type: "text", text: \`✓ Memory \${params.memoryId} deleted\` }],
          details: { deleted: params.memoryId },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: \`✗ Failed to delete: \${e?.message ?? e}\` }],
          details: { error: String(e) },
        };
      }
    },
  });

`;

// Only inject if not already present
if (!d.includes("memless_forget")) {
  d = d.slice(0, cmdStart) + forget + d.slice(cmdStart);
  console.log("injected memless_forget");
} else {
  console.log("memless_forget already present, skipping");
}

// Update /memless command body to add dashboard link + session stats
const oldTools = `          \`tools: memless_search  memless_recall  memless_remember\`,
          \`       memless_context memless_compress memless_checkpoint\`,
          \`       memless_index   memless_analytics\`,
        ].join("\\n"),`;

const newTools = `          \`session: \${toolCallCount} tool calls\`,
          \`\`,
          \`tools: memless_search  memless_recall  memless_remember  memless_forget\`,
          \`       memless_context memless_compress memless_checkpoint\`,
          \`       memless_index   memless_analytics\`,
          \`\`,
          \`dashboard: http://localhost:\${MEMLESS_PORT}\`,
        ].join("\\n"),`;

if (d.includes(oldTools)) {
  d = d.replace(oldTools, newTools);
  console.log("updated /memless command");
} else {
  console.log("WARNING: could not find tools block to update");
}

writeFileSync(path, d, "utf8");
console.log("done");
