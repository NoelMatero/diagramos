/**
 * A process that talked to rust-analyzer can exit once the server is gone.
 *
 * The bad outcome: `bench:planted` printed its whole report and then never
 * exited (2026-11-25: killed after 180 s by the batch script; without that, a
 * run sat for 35 minutes). The inspector showed one thing holding it open: the
 * JSON-RPC reader's partial-message timer. A server stopped halfway through
 * writing a message leaves half a message in the reader, whose 10 s timer
 * then re-arms itself forever, and `dispose()` does not clear it.
 *
 * No language server is started: a two-line "server" writes half a message
 * and dies.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
let scratch: string;

beforeEach(() => { scratch = mkdtempSync(path.join(os.tmpdir(), "lsp-exit-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("a connection to a server that died mid-message", () => {
  it("lets the process exit on its own once the server is gone", async () => {
    const script = path.join(scratch, "half-a-message.mts");
    writeFileSync(script, [
      `import { spawn } from "node:child_process";`,
      `import { connectTo } from ${JSON.stringify(path.join(REPO, "src/engine/referee-rust-lsp.ts"))};`,
      `const server = spawn(process.execPath, ["-e", ${JSON.stringify(
        `process.stdout.write("Content-Length: 100\\r\\n\\r\\n{\\"jsonrpc\\""); setTimeout(() => process.exit(0), 50);`,
      )}], { stdio: ["pipe", "pipe", "pipe"] });`,
      `const connection = await connectTo(server as never);`,
      `connection.listen();`,
      `await new Promise((resolve) => server.once("exit", resolve));`,
      `connection.dispose();`,
    ].join("\n"));
    const began = Date.now();
    const child = spawn(TSX, [script], { stdio: "ignore" });
    const ended = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 20_000);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    // Before the fix this sat until the 20 s kill, re-arming a 10 s timer forever.
    expect(ended).toBe(0);
    expect(Date.now() - began).toBeLessThan(15_000);
  }, 30_000);
});
