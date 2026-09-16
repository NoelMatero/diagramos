/**
 * How much Claude reads before it draws a box (#288).
 *
 * Two things arrive before the first `create_diagram`: the drawing guide, and
 * every tool's description as the MCP server lists them. A small model picks
 * the wrong parts out of a long read, so these are counted rather than
 * eyeballed. Tokens are estimated at four characters each, which is close
 * enough to compare a before and an after.
 *
 *   npx tsx scripts/measure-guidance.mts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokens = (chars: number) => `~${Math.round(chars / 4).toLocaleString("en")} tokens`;

const skill = readFileSync(path.join(REPO, "skills/diagram/SKILL.md"), "utf8");
console.log(
  `skills/diagram/SKILL.md  ${skill.split("\n").length} lines, `
  + `${skill.split(/\s+/).filter(Boolean).length.toLocaleString("en")} words, `
  + `${skill.length.toLocaleString("en")} chars (${tokens(skill.length)})`,
);

const client = new Client({ name: "measure-guidance", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.join(REPO, "src/mcp/server.ts")],
    cwd: REPO,
    env: { ...process.env, DIAGRAMOS_MCP_ROOT: REPO } as Record<string, string>,
  }),
);
const { tools } = await client.listTools();
await client.close();

/** What the model is sent for one tool: its description and its input schema. */
const size = (tool: (typeof tools)[number]) =>
  (tool.description ?? "").length + JSON.stringify(tool.inputSchema).length;
const total = tools.reduce((sum, tool) => sum + size(tool), 0);
console.log(`all ${tools.length} tools            ${total.toLocaleString("en")} chars (${tokens(total)})`);
for (const tool of [...tools].sort((a, b) => size(b) - size(a))) {
  console.log(`  ${tool.name.padEnd(20)} ${String(size(tool)).padStart(6)} chars`);
}
console.log(`before a first box      ${tokens(total + skill.length)}`);
