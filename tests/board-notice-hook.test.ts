/**
 * The session-start hook that says a board server is still running (#285).
 *
 * A server outlives the session that opened it, on purpose, and nothing ever
 * said it was there -- until a red "this page is out of date" on a board that
 * was fine sent its owner to `ps`, `lsof` and a log file to find out which
 * server was answering. This hook only tells. These tests hold it to that:
 * silent and node-free when nothing runs, one line when something does, never
 * a stopped process, never a non-zero exit.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "hooks/board-notice.sh");
const VERSION = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version as string;
/** Above any pid_max, so never a live process. */
const DEAD_PID = 4_194_305;

let sandbox: string;
let home: string;
let project: string;
let registry: string;
let bin: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "board-notice-"));
  home = path.join(sandbox, "home");
  project = path.join(home, "orangutan");
  registry = path.join(home, ".diagramos", "servers");
  bin = path.join(sandbox, "bin");
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/** A `node` first on PATH that records being started, so "no node" is observable. */
function spyNode(body = 'exec "$REAL_NODE" "$@"'): string {
  const log = path.join(sandbox, "node.log");
  const file = path.join(bin, "node");
  writeFileSync(file, `#!/bin/sh\necho started >> "${log}"\n${body}\n`);
  chmodSync(file, 0o755);
  return log;
}

function runHook(): { code: number; stdout: string; nodeStarted: boolean } {
  const log = spyNode();
  let code = 0;
  let stdout = "";
  try {
    stdout = execFileSync("sh", [HOOK], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        CLAUDE_PROJECT_DIR: project,
        REAL_NODE: process.execPath,
      },
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    code = (error as { status?: number }).status ?? -1;
  }
  return { code, stdout, nodeStarted: existsSync(log) };
}

function register(entry: Record<string, unknown>, name = `${String(entry.pid)}-${String(entry.port)}`): string {
  mkdirSync(registry, { recursive: true });
  const file = path.join(registry, `${name}.json`);
  writeFileSync(file, JSON.stringify(entry));
  return file;
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const installed = (version = VERSION) => ({
  version,
  builtFrom: [path.join(home, ".npm/_npx/abc/node_modules/diagramos/out/cli")],
  builtAt: 0,
});

function message(stdout: string): string {
  return (JSON.parse(stdout) as { systemMessage: string }).systemMessage;
}

describe("when no board server is running", () => {
  it("prints nothing and never starts node, with no registry at all", () => {
    expect(runHook()).toEqual({ code: 0, stdout: "", nodeStarted: false });
  });

  it("prints nothing and never starts node, with an empty registry", () => {
    mkdirSync(registry, { recursive: true });
    writeFileSync(path.join(registry, "service.log"), "old log\n");
    expect(runHook()).toEqual({ code: 0, stdout: "", nodeStarted: false });
  });

  it("prints nothing when every entry is a server that has already stopped, and deletes nothing", () => {
    const file = register({ pid: DEAD_PID, port: 4747, root: project, startedAt: hoursAgo(1), build: installed() });
    const run = runHook();
    expect(run).toMatchObject({ code: 0, stdout: "" });
    expect(existsSync(file)).toBe(true);
  });
});

describe("when a board server is running", () => {
  it("names it in one line: project, port, version, uptime, and how to stop it", () => {
    register({ pid: process.pid, port: 4747, root: project, startedAt: hoursAgo(3.1), build: installed() });
    const run = runHook();
    expect(run.code).toBe(0);
    expect(message(run.stdout)).toBe(
      `board running for orangutan on :4747 · ${VERSION} · up 3h · stop: npx diagramos stop`,
    );
  });

  it("puts this project's server first and counts the others", () => {
    const elsewhere = path.join(home, "board-ai");
    register({ pid: process.pid, port: 4800, root: elsewhere, startedAt: hoursAgo(30), build: installed() }, "a");
    register({ pid: process.pid, port: 4747, roots: [elsewhere, project], startedAt: hoursAgo(0.2), build: installed() }, "b");
    register({ pid: process.pid, port: 4900, root: path.join(home, "third"), startedAt: hoursAgo(50), build: installed() }, "c");
    const said = message(runHook().stdout);
    expect(said).toMatch(/^board running for orangutan on :4747 · .* · up 12m · /);
    expect(said).toContain("and 2 others (npx diagramos stop --list)");
  });

  it("still speaks when the only server is in another project, since that is the forgotten one", () => {
    register({ pid: process.pid, port: 4800, root: path.join(home, "board-ai"), startedAt: hoursAgo(50), build: installed() });
    expect(message(runHook().stdout)).toMatch(/^board running for board-ai on :4800 · .* · up 2d · /);
  });

  it("says when the server is an older version than the one installed", () => {
    register({ pid: process.pid, port: 4747, root: project, startedAt: hoursAgo(1), build: installed("0.1.9") });
    expect(message(runHook().stdout)).toContain(`0.1.9 · up 1h · older than the installed ${VERSION}`);
  });

  it("says when the server runs from a local checkout, and which one", () => {
    const checkout = path.join(home, "board-ai");
    register({
      pid: process.pid,
      port: 4747,
      root: project,
      startedAt: hoursAgo(1),
      build: { version: VERSION, builtFrom: [path.join(checkout, "out/cli")], builtAt: 0 },
    });
    expect(message(runHook().stdout)).toContain("· from ~/board-ai ·");
  });

  it("says when the server predates recording its build", () => {
    register({ pid: process.pid, port: 4747, root: project, startedAt: hoursAgo(1) });
    expect(message(runHook().stdout)).toContain("· unknown version, older than the installed");
  });
});

describe("it never gets in the way", () => {
  it("exits 0 on an unreadable entry", () => {
    mkdirSync(registry, { recursive: true });
    writeFileSync(path.join(registry, "1.json"), "{not json");
    expect(runHook()).toMatchObject({ code: 0, stdout: "" });
  });

  it("exits 0 when node itself fails", () => {
    register({ pid: process.pid, port: 4747, root: project, startedAt: hoursAgo(1), build: installed() });
    spyNode("exit 3");
    let code = 0;
    try {
      execFileSync("sh", [HOOK], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, stdio: "pipe" });
    } catch (error) {
      code = (error as { status?: number }).status ?? -1;
    }
    expect(code).toBe(0);
  });

  it("is registered as a SessionStart hook, through sh, and pins the manifest's version", () => {
    const hooks = JSON.parse(readFileSync(path.join(REPO, "hooks/hooks.json"), "utf8"));
    const start = hooks.hooks.SessionStart;
    expect(start).toHaveLength(1);
    expect(start[0].hooks[0].command).toMatch(/^sh .*hooks\/board-notice\.sh"?$/);
    const manifest = JSON.parse(readFileSync(path.join(REPO, ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest.version).toBe(VERSION);
    expect(readFileSync(HOOK, "utf8")).toContain(`INSTALLED=${VERSION}`);
  });
});
