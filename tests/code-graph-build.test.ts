/**
 * The code graph in a project that merely installed this tool.
 *
 * That project used to get no graph at all. The graph was built by a
 * post-commit hook installed from `npm prepare`, and `prepare` does not run for
 * a consumer -- the tool arrives as a marketplace clone plus `npx`. So the
 * arrow check read two languages instead of forty, and the one line that
 * mentioned the graph told the reader to run two `npm run` scripts out of
 * *diagramos's* package.json, which their Rust repo does not have (#132).
 *
 * Everything below is driven from a temp git repo with a fake `graphify` on a
 * controlled PATH, so the tests can prove which commands would run, how often,
 * and what the check says when the tool is not there -- without installing
 * anything. Two Rust files stand in for "a language the live channels cannot
 * read": that arrow is skipped without a graph and confirmed with one, which is
 * the whole point of building it.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDiagram } from "../src/engine/diagram";
import { emptyBoard, writeBoard } from "../src/engine/board-file";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const run = promisify(execFile);
const REPO = path.resolve(__dirname, "..");
const DRIFT = path.join(REPO, "scripts/check-drift.mjs");
const REFRESH = path.join(REPO, "scripts/refresh-code-graph.mjs");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let project: string;
/** Directory holding the fakes, and the only unusual entry on PATH. */
let bin: string;
let log: string;

/**
 * A PATH with our fakes, node, and the system directories git lives in --
 * deliberately without the developer's own `~/.local/bin`, where a real
 * graphify or uv would otherwise make "the tool is missing" untestable.
 */
function fakePath(): string {
  return `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
}

function write(file: string, contents: string): void {
  const target = path.join(project, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: project,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function head(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
}

/** A graph the loader accepts, saying src/a.rs reaches src/b.rs. */
const GRAPH = JSON.stringify({
  nodes: [
    { id: "a", source_file: "src/a.rs" },
    { id: "b", source_file: "src/b.rs" },
  ],
  links: [{ source: "a", target: "b", relation: "imports", confidence: "EXTRACTED" }],
});

/**
 * A fake graphify.
 *
 * `--version` answers the way the real one does, because that probe is how both
 * callers decide the tool exists. `extract` writes the graph into the working
 * directory it was given, which is what proves the build ran in the *project*
 * and not somewhere else.
 */
function fakeGraphify({ extractStatus = 0, version = "0.9.47" } = {}): void {
  const file = path.join(bin, "graphify");
  writeFileSync(
    file,
    `#!/bin/sh\necho "graphify $*" >> "${log}"\n`
    + `case "$1" in --version) echo "graphify ${version}"; exit 0 ;; esac\n`
    // A failed extraction leaves nothing behind, the way the real one does.
    + `if [ ${extractStatus} -ne 0 ]; then exit ${extractStatus}; fi\n`
    + `mkdir -p graphify-out\n`
    + `cat > graphify-out/graph.json <<'JSON'\n${GRAPH}\nJSON\n`
    + `exit 0\n`,
  );
  chmodSync(file, 0o755);
}

/** A Python tool installer that exists and is never asked to install anything. */
function fakeInstaller(name: string): void {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
  chmodSync(file, 0o755);
}

function calls(): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function extractions(): number {
  return calls().filter((call) => call.startsWith("graphify extract")).length;
}

async function drift(...args: string[]): Promise<string> {
  const env = { ...process.env, PATH: fakePath() };
  try {
    const { stdout, stderr } = await run(TSX, [DRIFT, ...args], { cwd: project, env });
    return `${stdout}${stderr}`;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
}

/** A board with one arrow between two Rust files, or with no arrow at all. */
async function board({ arrow = true } = {}): Promise<void> {
  const made = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "a", label: "Reactor", ref: "src/a.rs" },
      { id: "b", label: "Handler", ref: "src/b.rs" },
    ],
    edges: arrow ? [{ from: "a", to: "b" }] : [],
  });
  await writeBoard(path.join(project, "docs/diagrams/arch.excalidraw"), made.board);
}

beforeEach(async () => {
  project = mkdtempSync(path.join(tmpdir(), "code-graph-"));
  bin = mkdtempSync(path.join(tmpdir(), "code-graph-bin-"));
  log = path.join(bin, "calls.log");
  write("src/a.rs", "mod b;\npub fn serve() { b::handle(); }\n");
  write("src/b.rs", "pub fn handle() {}\n");
  await board();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "a project with diagrams");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("the check builds the code graph it needs", () => {
  it("builds one when the project has none, and uses it on that same run", async () => {
    fakeGraphify();
    const said = await drift("--details");

    expect(extractions()).toBe(1);
    // Where the build happened: in the project, dated to its commit.
    const sidecar = JSON.parse(
      readFileSync(path.join(project, "graphify-out/code-graph-meta.json"), "utf8"),
    );
    expect(sidecar).toEqual({ commit: head(), graphify: "0.9.47" });
    // The arrow between two Rust files is the one the live channels cannot
    // read. Built and consulted on this run, it is no longer skipped.
    expect(said).not.toContain("not TypeScript or JavaScript");
    expect(said).toContain("built the code graph");
  }, 120_000);

  it("skips the arrow when there is no graphify, which is the state this fixes", async () => {
    const said = await drift("--details");
    expect(extractions()).toBe(0);
    expect(said).toContain("not TypeScript or JavaScript");
  }, 120_000);

  it("does not build again while the graph still describes this commit", async () => {
    fakeGraphify();
    await drift();
    const second = await drift();
    expect(extractions()).toBe(1);
    // Said once ever, not once per run.
    expect(second).not.toContain("built the code graph");
  }, 120_000);

  it("rebuilds after a commit lands", async () => {
    fakeGraphify();
    await drift();
    write("src/c.rs", "pub fn later() {}\n");
    git("add", "-A");
    git("commit", "-qm", "more code");
    await drift();
    expect(extractions()).toBe(2);
  }, 120_000);

  it("spends nothing on a board with no arrow, since only arrows use the graph", async () => {
    fakeGraphify();
    await board({ arrow: false });
    await drift();
    expect(extractions()).toBe(0);
  }, 120_000);

  it("spends nothing when the arrow check is off", async () => {
    fakeGraphify();
    await drift("--no-edges");
    expect(extractions()).toBe(0);
  }, 120_000);

  it("stays out of it entirely when asked", async () => {
    fakeGraphify();
    const said = await run(TSX, [DRIFT, "--details"], {
      cwd: project,
      env: { ...process.env, PATH: fakePath(), DIAGRAMOS_SKIP_GRAPHIFY: "1" },
    }).then((result) => `${result.stdout}${result.stderr}`).catch(
      (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ""}${error.stderr ?? ""}`,
    );
    expect(extractions()).toBe(0);
    // Somebody who opted out is not told about it every turn, or at all.
    expect(said).not.toContain("code graph");
    expect(said).not.toContain("graphify");
  }, 120_000);

  it("tries once per commit when the extraction fails, and says the graph is not there", async () => {
    // A repo where graphify errors, or takes longer than the check will wait,
    // must not pay for it on every turn.
    fakeGraphify({ extractStatus: 1 });
    const first = await drift();
    await drift();
    expect(extractions()).toBe(1);
    expect(first).toContain("no code graph here the check can use");
  }, 120_000);

  it("does not build a graph the check would refuse on arrival", async () => {
    // The reader only trusts the graphify releases this project has tested
    // against. Spending seconds on a graph it will refuse is worse than not
    // having one, because the seconds are real and the coverage is not.
    fakeGraphify({ version: "1.2.0" });
    const said = await drift("--details");
    expect(extractions()).toBe(0);
    expect(said).toContain("not TypeScript or JavaScript");
    expect(said).not.toContain("built the code graph");
  }, 120_000);

  it("leaves nothing in the project's git status", async () => {
    // Building writes a megabyte of derived JSON into a repo that never asked
    // for it. Uncommittable by construction, rather than by a note in a README.
    fakeGraphify();
    await drift();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" });
    expect(status).not.toContain("graphify-out");
  }, 120_000);
});

describe("what the check says when graphify is missing", () => {
  it("never names a script from diagramos's own package.json", async () => {
    // The bug: correct advice addressed to the wrong reader.
    const said = await drift("--details");
    expect(said).not.toContain("npm run graph:install");
    expect(said).not.toContain("npm run graph:refresh");
    expect(said).not.toContain("npm run");
  }, 120_000);

  it("names an install this machine can actually run, when it has one", async () => {
    fakeInstaller("uv");
    const said = await drift("--details");
    expect(said).toContain("uv tool install graphifyy");
    // Named, not run: installing a Python tool is not a check's decision.
    expect(calls().some((call) => call.startsWith("uv tool install"))).toBe(false);
  }, 120_000);

  it("prefers uv over pipx, the same order the installer uses", async () => {
    fakeInstaller("uv");
    fakeInstaller("pipx");
    expect(await drift("--details")).toContain("uv tool install");
  }, 120_000);

  it("says the arrows cannot be checked here when there is nothing to install it with", async () => {
    // A Rust repo with no Python toolchain. Sending the reader off to acquire
    // one is not advice, so the honest sentence stops at what is true.
    const said = await drift("--details");
    expect(said).toContain("cannot be checked in this project");
    expect(said).not.toContain("uv tool install");
  }, 120_000);
});

describe("the post-commit hook still builds through the same code", () => {
  it("writes the graph and its sidecar", async () => {
    fakeGraphify();
    await run(process.execPath, [REFRESH], { cwd: project, env: { ...process.env, PATH: fakePath() } });
    expect(extractions()).toBe(1);
    const sidecar = JSON.parse(
      readFileSync(path.join(project, "graphify-out/code-graph-meta.json"), "utf8"),
    );
    expect(sidecar).toEqual({ commit: head(), graphify: "0.9.47" });
  }, 120_000);

  it("exits 0 with no graphify, so it can never block a commit", async () => {
    const result = await run(process.execPath, [REFRESH], {
      cwd: project,
      env: { ...process.env, PATH: fakePath() },
    });
    expect(result.stderr).toBe("");
    expect(existsSync(path.join(project, "graphify-out"))).toBe(false);
  }, 120_000);
});
