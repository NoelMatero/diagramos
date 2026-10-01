/**
 * A language server the checker started does not outlive the checker (#403).
 *
 * The referees stop their server on a normal `close()`. When the process
 * holding the referee dies instead -- a hook's timeout, a `kill -9`, an MCP
 * server shut down mid-check -- the server has to go with it, and a server
 * stuck in its own shutdown will not go by itself (`server-process.ts` has
 * the five rust-analyzers found that way on 2026-10-01).
 *
 * So each test does what a timeout does: starts a server from a child
 * process, kills that process with SIGKILL (no handler runs, no `finally`,
 * no `exit` event), and asserts that nothing the child started is still
 * running a few seconds later. Everything the child started, not only the
 * process it spawned: pyright runs behind `npx`, and rust-analyzer starts a
 * proc-macro server of its own.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

/** Every live process as pid, parent pid and command. */
function processes(): Array<{ pid: number; ppid: number; command: string }> {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

/** Every process descended from `root`, not counting `root` itself. */
function descendantsOf(root: number): Array<{ pid: number; command: string }> {
  const all = processes();
  const mine = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const one of all) {
      if (!mine.has(one.pid) && mine.has(one.ppid)) { mine.add(one.pid); grew = true; }
    }
  }
  return all.filter((one) => one.pid !== root && mine.has(one.pid));
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

let repo: string | undefined;
let started: number[] = [];

afterEach(() => {
  // A failing test must not leave the very thing it is about behind.
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  started = [];
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

/**
 * Starts `createReferee` in a child, waits until the server has answered its
 * handshake, then kills the child with SIGKILL and returns what it had started
 * and what of that is still alive after `graceMs`.
 */
async function killParentOf(
  module: string,
  create: string,
  root: string,
  graceMs = 5_000,
  /** Put first on the child's PATH, for a stand-in server. */
  bin?: string,
): Promise<{ before: Array<{ pid: number; command: string }>; left: Array<{ pid: number; command: string }> }> {
  const script = path.join(root, ".child.mts");
  writeFileSync(script, [
    `import { ${create} } from ${JSON.stringify(path.join(REPO, module))};`,
    `await ${create}(${JSON.stringify(root)});`,
    "process.stdout.write(\"READY\\n\");",
    "setInterval(() => {}, 1_000);",
  ].join("\n"));
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: REPO, stdio: ["ignore", "pipe", "inherit"],
    env: bin ? { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } : process.env,
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("READY")) resolve(); });
    child.once("exit", (code) => reject(new Error(`the child exited (${code}) before its server started`)));
  });
  const before = descendantsOf(child.pid!);
  started = before.map((one) => one.pid);
  const gone = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await gone;
  await new Promise((resolve) => { setTimeout(resolve, graceMs); });
  return { before, left: before.filter((one) => alive(one.pid)) };
}

/*
 * A language server that does not notice its input closing.
 *
 * The real ones usually do, and exit on their own when the checker dies --
 * the two live tests below pin that. rust-analyzer does not always: the
 * strays found on 2026-10-01 had their input closed and were each stuck in
 * shutdown, the main thread waiting on a writer thread that waits for a
 * message nothing will send. That hang depends on what the server was doing,
 * so it cannot be produced on demand. This stand-in has it every time: it
 * answers the handshake, then ignores the end of its input and every signal
 * short of KILL.
 */
const FAKE_SERVER = `
process.on("SIGHUP", () => {});
process.on("SIGPIPE", () => {});
process.stdin.on("end", () => {});
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const head = buffer.indexOf("\\r\\n\\r\\n");
    if (head < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, head).toString())[1]);
    if (buffer.length < head + 4 + length) return;
    const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString());
    buffer = buffer.subarray(head + 4 + length);
    if (message.id === undefined || message.method === undefined) continue;
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize" ? { capabilities: {} } : null });
    process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
  }
});
setInterval(() => {}, 1_000);
`;

/**
 * `rust-analyzer` and `npx` on a PATH of their own, both the server above.
 * `npx` runs it as a child rather than replacing itself, as the real one does,
 * so pyright's server is a grandchild of the checker.
 */
function fakeServers(root: string): string {
  const bin = path.join(root, ".fake-bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "server.cjs"), FAKE_SERVER);
  const node = JSON.stringify(process.execPath);
  const server = JSON.stringify(path.join(bin, "server.cjs"));
  writeFileSync(path.join(bin, "rust-analyzer"), `#!/bin/sh\nexec ${node} ${server}\n`);
  writeFileSync(path.join(bin, "npx"), `#!/bin/sh\ntrap '' HUP TERM\n${node} ${server}\n`);
  chmodSync(path.join(bin, "rust-analyzer"), 0o755);
  chmodSync(path.join(bin, "npx"), 0o755);
  return bin;
}

describe.skipIf(process.platform === "win32")("a server that ignores its input closing still dies with the checker", () => {
  it("rust-analyzer", async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "servers-die-fake-rust-"));
    writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
    const bin = fakeServers(repo);

    const { before, left } = await killParentOf(
      "src/engine/referee-rust-lsp.ts", "createRustAnalyzerReferee", repo, 5_000, bin);

    expect(before.some((one) => one.command.includes("server.cjs"))).toBe(true);
    expect(left).toEqual([]);
  }, 60_000);

  it("pyright, started through npx", async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "servers-die-fake-python-"));
    writeFileSync(path.join(repo, "one.py"), "def one() -> int:\n    return 1\n");
    const bin = fakeServers(repo);

    const { before, left } = await killParentOf(
      "src/engine/referee-python-lsp.ts", "createPyrightLspReferee", repo, 5_000, bin);

    expect(before.some((one) => one.command.includes("server.cjs"))).toBe(true);
    expect(left).toEqual([]);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("a language server dies with the process that started it", () => {
  it.skipIf(!hasRustAnalyzer)("rust-analyzer", async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "servers-die-rust-"));
    writeFileSync(path.join(repo, "Cargo.toml"),
      "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n");
    mkdirSync(path.join(repo, "src"));
    writeFileSync(path.join(repo, "src/lib.rs"), "pub fn one() -> u32 { 1 }\n");

    const { before, left } = await killParentOf("src/engine/referee-rust-lsp.ts", "createRustAnalyzerReferee", repo);

    expect(before.some((one) => one.command.includes("rust-analyzer"))).toBe(true);
    expect(left).toEqual([]);
  }, 60_000);

  it("pyright", async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "servers-die-python-"));
    writeFileSync(path.join(repo, "one.py"), "def one() -> int:\n    return 1\n");

    const { before, left } = await killParentOf("src/engine/referee-python-lsp.ts", "createPyrightLspReferee", repo);

    expect(before.some((one) => one.command.includes("pyright"))).toBe(true);
    expect(left).toEqual([]);
  }, 60_000);
});
