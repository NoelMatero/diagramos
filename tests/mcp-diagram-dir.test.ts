/**
 * Where `create_diagram` is allowed to write, and what the tools say when a
 * project's diagrams are somewhere they will never be found.
 *
 * The guarantee under test: discovery is trustworthy because authoring is
 * confined. `check_drift` and the board CLI find diagrams by looking in one
 * directory, so a board written outside it is invisible and the check reports
 * clean rather than admitting it never saw the file. Refusing to create one
 * means there is nothing to be blind to.
 *
 * The other half, equally important: only *authoring* is confined. Reading a
 * board that already lives elsewhere still works, so adding this rule cannot
 * break a project that predates it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { CONFIG_FILE } from "../src/engine/config";

const REPO = path.resolve(__dirname, "..");

/** A server rooted at its own workspace, so one project's config cannot leak into another's. */
async function connect(workspace: string): Promise<Client> {
  const client = new Client({ name: "diagram-dir-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(REPO, "src/mcp/server.ts")],
      cwd: REPO,
      env: { ...process.env, DIAGRAMOS_MCP_ROOT: workspace },
    }),
  );
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

/** Unlike the usual helper, hands back failures instead of throwing: refusal is the subject here. */
async function attempt(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { failed: Boolean((result as { isError?: boolean }).isError), text: textOf(result) };
}

const NODES = [{ id: "a", label: "Auth" }];

let plain: string;
let configured: string;
let plainClient: Client;
let configuredClient: Client;

beforeAll(async () => {
  plain = mkdtempSync(path.join(os.tmpdir(), "diagram-dir-plain-"));
  configured = mkdtempSync(path.join(os.tmpdir(), "diagram-dir-set-"));
  writeFileSync(path.join(configured, CONFIG_FILE), JSON.stringify({ diagrams: "docs/architecture" }));
  [plainClient, configuredClient] = await Promise.all([connect(plain), connect(configured)]);
}, 180_000);

afterAll(async () => {
  await Promise.all([plainClient?.close(), configuredClient?.close()]);
  for (const directory of [plain, configured]) {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("create_diagram is confined to the diagram directory", () => {
  it("writes to docs/diagrams without being told to", async () => {
    const result = await attempt(plainClient, "create_diagram", {
      path: "docs/diagrams/architecture.excalidraw",
      nodes: NODES,
    });
    expect(result.failed, result.text).toBe(false);
  }, 120_000);

  it("refuses a board somewhere else, and says where it belongs", async () => {
    const result = await attempt(plainClient, "create_diagram", { path: "notes/api.excalidraw", nodes: NODES });
    expect(result.failed).toBe(true);
    // The message has to carry the way out, or the model retries the same path
    // or picks another one just as invisible.
    expect(result.text).toContain("docs/diagrams");
    expect(result.text).toContain(CONFIG_FILE);
    expect(result.text).toContain(path.join("docs/diagrams", "api.excalidraw"));
  }, 120_000);

  it("refuses the repository root, which is the tempting near-miss", async () => {
    const result = await attempt(plainClient, "create_diagram", { path: "architecture.excalidraw", nodes: NODES });
    expect(result.failed).toBe(true);
  }, 120_000);

  it("still refuses a path escaping the workspace, for the older reason", async () => {
    const result = await attempt(plainClient, "create_diagram", { path: "../../etc/passwd", nodes: NODES });
    expect(result.failed).toBe(true);
    expect(result.text).toMatch(/workspace/i);
  }, 120_000);
});

describe("the committed setting moves the whole rule", () => {
  it("allows the configured directory", async () => {
    const result = await attempt(configuredClient, "create_diagram", {
      path: "docs/architecture/system.excalidraw",
      nodes: NODES,
    });
    expect(result.failed, result.text).toBe(false);
  }, 120_000);

  it("refuses docs/diagrams once the project has named somewhere else", async () => {
    // Proof that the default is not a second, permanently blessed location.
    const result = await attempt(configuredClient, "create_diagram", {
      path: "docs/diagrams/system.excalidraw",
      nodes: NODES,
    });
    expect(result.failed).toBe(true);
    expect(result.text).toContain("docs/architecture");
  }, 120_000);
});

describe("boards that already live elsewhere", () => {
  it("can still be read, so the rule breaks nothing that predates it", async () => {
    // A board outside the diagram directory, of the kind this rule stops being
    // created but must not stop being used.
    const stray = path.join(plain, "notes/legacy.excalidraw");
    mkdirSync(path.dirname(stray), { recursive: true });
    copyFileSync(path.join(plain, "docs/diagrams/architecture.excalidraw"), stray);

    const result = await attempt(plainClient, "read_diagram", { path: "notes/legacy.excalidraw" });
    expect(result.failed, result.text).toBe(false);
    expect(result.text).toContain("Auth");
  }, 120_000);

  it("are named by check_drift when it had nothing to check", async () => {
    // The blind spot in one assertion: a project whose only boards are strays
    // must not be told everything is fine.
    const empty = mkdtempSync(path.join(os.tmpdir(), "diagram-dir-stray-"));
    const client = await connect(empty);
    try {
      mkdirSync(path.join(empty, "diagrams"), { recursive: true });
      copyFileSync(
        path.join(plain, "docs/diagrams/architecture.excalidraw"),
        path.join(empty, "diagrams/arch.excalidraw"),
      );

      const result = await attempt(client, "check_drift", {});
      expect(result.failed, result.text).toBe(false);
      const report = JSON.parse(result.text) as {
        checked?: number;
        clean?: boolean;
        boardsElsewhere?: string[];
      };
      expect(report.checked).toBe(0);
      // Never "clean" over zero comparisons.
      expect(report.clean).toBeUndefined();
      expect(report.boardsElsewhere).toEqual([path.join("diagrams", "arch.excalidraw")]);
    } finally {
      await client.close();
      rmSync(empty, { recursive: true, force: true });
    }
  }, 180_000);
});
