/**
 * A routine that hands a function to code that runs it reaches whatever that
 * function reaches (#484).
 *
 * mobx's `runReactions` writes `reactionScheduler(runReactionsHelper)`. The
 * scheduler is `f => f()`, and `setReactionScheduler` replaces it while the
 * program runs. The check read every call `runReactions` writes, found none
 * reaching `Reaction`, found `Reaction` calling `runReactions`, and told the
 * board to turn a correct arrow round.
 *
 * Two shapes, in every language the check accuses in:
 *
 *   - a call into a routine of this repository that calls its own
 *     parameter, handed a function -- what runs is the function handed;
 *   - a call to a name the code sets again somewhere else -- what runs is
 *     whatever was put there last.
 *
 * Each must leave a correct arrow "not sure", never red. And the guard the
 * other way: the same accusations, where nothing is handed on and nothing is
 * replaced, still stand.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/** The same check every other rust-analyzer test here makes: the live half needs the real binary. */
const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

async function checked(fromRef: string, toRef: string): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "caller", ref: fromRef },
      { id: "callee", label: "callee", ref: toRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return live.report;
}

const accusations = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind)).map((finding) => finding.kind);

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "calls-runner-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** One language's fixture: correct arrows that must not go red, and wrong ones that must keep their red. */
interface Shapes {
  files: Record<string, string>;
  right: Array<[string, string, string]>;
  wrong: Array<[string, string, string, string]>;
}

function shapes(language: string, fixture: Shapes, timeout: number, skip = false): void {
  describe.skipIf(skip)(language, () => {
    it.each(fixture.right)("is not red when %s", async (_shape, from, to) => {
      write(fixture.files);
      expect(accusations(await checked(from, to))).toEqual([]);
    }, timeout);

    it.each(fixture.wrong)("still accuses when %s", async (_shape, from, to, kind) => {
      write(fixture.files);
      expect(accusations(await checked(from, to))).toEqual([kind]);
    }, timeout);
  });
}

shapes("TypeScript", {
  files: {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
    "b.ts": "export function target(): void {}\n",
    "q.ts": "export function later(task: () => void): void {\n  task();\n}\n",
    // mobx's own shape: a scheduler held in a `let`, replaced at run time, that runs what it is handed.
    "reaction.ts": [
      "export class Reaction {\n  schedule(): void { runReactions(); }\n  runReaction(): void {}\n}",
      "const pending: Reaction[] = [];",
      "function runReactionsHelper(): void { for (const r of pending) r.runReaction(); }",
      "export function setScheduler(s: (f: () => void) => void): void { const base = scheduler; scheduler = (f) => s(() => base(f)); }",
      "export function runReactions(): void { scheduler(runReactionsHelper); }",
      "let scheduler: (fn: () => void) => void = (f) => f();",
      "",
    ].join("\n"),
    // The same, spelled `f => f()`: #477 reads both as a function.
    "bare.ts": [
      "export class Job {\n  schedule(): void { runJobs(); }\n  run(): void {}\n}",
      "const jobs: Job[] = [];",
      "function runJobsHelper(): void { for (const j of jobs) j.run(); }",
      "export function setRunner(s: (f: () => void) => void): void { runner = s; }",
      "export function runJobs(): void { runner(runJobsHelper); }",
      "let runner: (fn: () => void) => void = f => f();",
      "",
    ].join("\n"),
    "a.ts": [
      "import { target } from \"./b\";",
      "import { later } from \"./q\";",
      "",
      "function runNow(f: () => void): void {\n  f();\n}",
      "const runSoon = (f: () => void) => f();",
      "function keep(f: () => void): void {\n  kept.push(f);\n}",
      "const kept: Array<() => void> = [];",
      "function log(n: number): void {\n  console.log(n);\n}",
      "let count = (n: number) => n + 1;",
      "let hook: () => void = () => {};",
      "export function setHook(h: () => void): void {\n  hook = h;\n}",
      "",
      "function helper(): void {\n  work();\n}",
      "function reachTarget(): void {\n  target();\n}",
      "export function work(): void {\n  viaRunner(); viaArrow(); viaOtherFile(); relay(helper); fire(); stored(); plain(); bump();\n}",
      "export function viaRunner(): void {\n  runNow(helper);\n}",
      "export function viaArrow(): void {\n  runSoon(helper);\n}",
      "export function viaOtherFile(): void {\n  later(helper);\n}",
      "export function relay(cb: () => void): void {\n  runNow(cb);\n}",
      "export function toTarget(): void {\n  runNow(reachTarget);\n}",
      "export function fire(): void {\n  hook();\n}",
      "export function stored(): void {\n  keep(helper);\n}",
      "export function plain(): void {\n  log(1);\n}",
      "export function bump(): number {\n  return count(1);\n}",
      // #491: what is handed on can't lead to the far end, so the doubt is about a route that doesn't exist.
      "function idle(): void {}",
      "function quiet(): void {\n  idle();\n}",
      "function makeNums(): number[] {\n  return [1, 2];\n}",
      "function sum(): number {\n  return makeNums().reduce((a, b) => a + b, 0);\n}",
      "function chained(): void {\n  helper();\n}",
      "function vague(): void {\n  kept[0]!();\n}",
      "export function apart(): void {\n  runNow(quiet);\n}",
      "export function apartFar(): void {\n  runNow(quiet);\n}",
      "export function tally(): void {\n  runNow(sum);\n}",
      "export function viaChain(): void {\n  runNow(chained);\n}",
      "export function unsure(): void {\n  runNow(vague);\n}",
      "export function again(): void {\n  apart(); tally(); viaChain(); unsure();\n}",
      "",
    ].join("\n"),
    // #491: the far end is a class, and the function handed on calls one of its methods.
    "widget.ts": [
      "export class Widget {\n  start(): void { kick(); }\n  poke(): void {}\n}",
      "const widgets: Widget[] = [];",
      "function runNow(f: () => void): void {\n  f();\n}",
      "function pokeAll(): void {\n  for (const w of widgets) w.poke();\n}",
      "export function kick(): void {\n  runNow(pokeAll);\n}",
      "",
    ].join("\n"),
  },
  right: [
    ["the work goes through a replaced scheduler (mobx, `(f) => f()`)", "reaction.ts#runReactions", "reaction.ts#Reaction"],
    ["the work goes through a replaced scheduler (`f => f()`)", "bare.ts#runJobs", "bare.ts#Job"],
    ["a function is handed to a routine that calls its parameter", "a.ts#viaRunner", "a.ts#work"],
    ["a function is handed to an arrow function that calls its parameter", "a.ts#viaArrow", "a.ts#work"],
    ["a function is handed to such a routine in another file", "a.ts#viaOtherFile", "a.ts#work"],
    ["the far end is in another file and only the handed function calls it", "a.ts#toTarget", "b.ts#target"],
    ["the call is to a `let` the code replaces", "a.ts#fire", "a.ts#work"],
    ["the function handed on reaches the far end in steps (#491)", "a.ts#viaChain", "a.ts#work"],
    ["the function handed on makes a call nothing can place (#491)", "a.ts#unsure", "a.ts#again"],
    ["the far end is a class, and the function handed on calls its method (#491)", "widget.ts#kick", "widget.ts#Widget"],
  ],
  wrong: [
    ["a function is handed to a routine that only stores it", "a.ts#stored", "a.ts#work", "calls-backwards"],
    ["nothing is handed on", "a.ts#plain", "a.ts#work", "calls-backwards"],
    ["the call is to a `let` nothing replaces", "a.ts#bump", "a.ts#work", "calls-backwards"],
    ["nothing is handed on, and the far end is in another file", "a.ts#plain", "b.ts#target", "calls-refuted"],
    ["the function handed on can't reach the far end (#491, drizzle)", "a.ts#apart", "a.ts#again", "calls-backwards"],
    ["the function handed on can't reach the far end, in another file (#491)", "a.ts#apartFar", "b.ts#target", "calls-refuted"],
    ["the function handed on calls a library method on a value the compiler types (#491)", "a.ts#tally", "a.ts#again", "calls-backwards"],
  ],
}, 120_000);

shapes("Python", {
  files: {
    "b.py": "def target():\n    pass\n",
    "q.py": "def later(task):\n    task()\n",
    "reaction.py": [
      "class Reaction:\n    def schedule(self):\n        run_reactions()\n\n    def run_reaction(self):\n        pass",
      "pending = []",
      "def run_reactions_helper():\n    for r in pending:\n        r.run_reaction()",
      "scheduler = lambda f: f()",
      "def set_scheduler(s):\n    global scheduler\n    base = scheduler\n    scheduler = lambda f: s(lambda: base(f))",
      "def run_reactions():\n    scheduler(run_reactions_helper)",
      "",
    ].join("\n\n\n"),
    "a.py": [
      "from b import target\nfrom q import later",
      "def run_now(f):\n    f()",
      "run_soon = lambda f: f()",
      "kept = []",
      "def keep(f):\n    kept.append(f)",
      "def log(n):\n    print(n)",
      "def count(n):\n    return n + 1",
      "def noop():\n    pass",
      "hook = noop",
      "def set_hook(h):\n    global hook\n    hook = h",
      "def helper():\n    work()",
      "def reach_target():\n    target()",
      "def work():\n    via_runner()\n    via_lambda()\n    via_other_file()\n    by_keyword()\n    relay(helper)\n    fire()\n    stored()\n    plain()\n    bump()",
      "def via_runner():\n    run_now(helper)",
      "def via_lambda():\n    run_soon(helper)",
      "def via_other_file():\n    later(helper)",
      "def by_keyword():\n    run_now(f=helper)",
      "def relay(cb):\n    run_now(cb)",
      "def to_target():\n    run_now(reach_target)",
      "def fire():\n    hook()",
      "def stored():\n    keep(helper)",
      "def plain():\n    log(1)",
      "def bump():\n    return count(1)",
      "def idle():\n    pass",
      "def quiet():\n    idle()",
      "def chained():\n    helper()",
      "def vague():\n    kept[0]()",
      "def apart():\n    run_now(quiet)",
      "def apart_far():\n    run_now(quiet)",
      "def via_chain():\n    run_now(chained)",
      "def unsure():\n    run_now(vague)",
      "def again():\n    apart()\n    via_chain()\n    unsure()",
      "",
    ].join("\n\n\n"),
    "widget.py": [
      "class Widget:\n    def start(self):\n        kick()\n\n    def poke(self):\n        pass",
      "widgets = []",
      "def run_now(f):\n    f()",
      "def poke_all():\n    for w in widgets:\n        w.poke()",
      "def kick():\n    run_now(poke_all)",
      "",
    ].join("\n\n\n"),
  },
  right: [
    ["the work goes through a replaced scheduler (mobx's shape)", "reaction.py#run_reactions", "reaction.py#Reaction"],
    ["a function is handed to a routine that calls its parameter", "a.py#via_runner", "a.py#work"],
    ["a function is handed to a lambda that calls its parameter", "a.py#via_lambda", "a.py#work"],
    ["a function is handed to such a routine in another file", "a.py#via_other_file", "a.py#work"],
    ["a function is handed on as a keyword argument", "a.py#by_keyword", "a.py#work"],
    ["the far end is in another file and only the handed function calls it", "a.py#to_target", "b.py#target"],
    ["the call is to a name a function sets again through `global`", "a.py#fire", "a.py#work"],
    ["the function handed on reaches the far end in steps (#491)", "a.py#via_chain", "a.py#work"],
    ["the function handed on makes a call nothing can place (#491)", "a.py#unsure", "a.py#again"],
    ["the far end is a class, and the function handed on calls its method (#491)", "widget.py#kick", "widget.py#Widget"],
  ],
  wrong: [
    ["a function is handed to a routine that only stores it", "a.py#stored", "a.py#work", "calls-backwards"],
    ["nothing is handed on", "a.py#plain", "a.py#work", "calls-backwards"],
    ["the call is to a function nothing replaces", "a.py#bump", "a.py#work", "calls-backwards"],
    ["nothing is handed on, and the far end is in another file", "a.py#plain", "b.py#target", "calls-refuted"],
    ["the function handed on can't reach the far end (#491, drizzle)", "a.py#apart", "a.py#again", "calls-backwards"],
    ["the function handed on can't reach the far end, in another file (#491)", "a.py#apart_far", "b.py#target", "calls-refuted"],
  ],
}, 120_000);

shapes("Rust", {
  files: {
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
    "src/lib.rs": "pub mod a;\npub mod b;\npub mod q;\n",
    "src/b.rs": "pub fn target() {}\n",
    "src/q.rs": "pub fn later<F: FnOnce()>(task: F) {\n    task()\n}\n",
    "src/a.rs": [
      "use crate::b::target;\nuse crate::q::later;",
      "pub struct Reaction;",
      "impl Reaction {\n    pub fn schedule(&self) {\n        run_reactions();\n    }\n\n    pub fn run_reaction(&self) {}\n}",
      "fn run_now<F: FnOnce()>(f: F) {\n    f()\n}",
      "fn run_dyn(f: &dyn Fn()) {\n    f()\n}",
      "fn keep(f: fn()) -> fn() {\n    f\n}",
      "fn log(n: u8) {\n    let _ = n;\n}",
      "fn helper() {\n    work();\n}",
      "fn reactions_helper() {\n    Reaction.run_reaction();\n}",
      "fn reach_target() {\n    target();\n}",
      "pub fn work() {\n    via_runner();\n    via_dyn();\n    via_other_file();\n    stored();\n    plain();\n}",
      "pub fn run_reactions() {\n    run_now(reactions_helper);\n}",
      "pub fn via_runner() {\n    run_now(helper);\n}",
      "pub fn via_dyn() {\n    run_dyn(&helper);\n}",
      "pub fn via_other_file() {\n    later(helper);\n}",
      "pub fn to_target() {\n    run_now(reach_target);\n}",
      "pub fn stored() {\n    let _ = keep(helper);\n}",
      "pub fn plain() {\n    log(1);\n}",
      "fn idle() {}",
      "fn quiet() {\n    idle();\n}",
      "fn chained() {\n    helper();\n}",
      "pub fn apart() {\n    run_now(quiet);\n}",
      "pub fn apart_far() {\n    run_now(quiet);\n}",
      "pub fn via_chain() {\n    run_now(chained);\n}",
      "pub fn again() {\n    apart();\n    via_chain();\n}",
      "",
    ].join("\n\n"),
  },
  right: [
    ["the work goes through a routine that runs what it is handed", "src/a.rs#run_reactions", "src/a.rs#Reaction"],
    ["a function is handed to a routine that calls its parameter", "src/a.rs#via_runner", "src/a.rs#work"],
    ["a reference to a function is handed on", "src/a.rs#via_dyn", "src/a.rs#work"],
    ["a function is handed to such a routine in another file", "src/a.rs#via_other_file", "src/a.rs#work"],
    ["the far end is in another file and only the handed function calls it", "src/a.rs#to_target", "src/b.rs#target"],
    ["the function handed on reaches the far end in steps (#491)", "src/a.rs#via_chain", "src/a.rs#work"],
  ],
  wrong: [
    ["a function is handed to a routine that only returns it", "src/a.rs#stored", "src/a.rs#work", "calls-backwards"],
    ["nothing is handed on", "src/a.rs#plain", "src/a.rs#work", "calls-backwards"],
    ["nothing is handed on, and the far end is in another file", "src/a.rs#plain", "src/b.rs#target", "calls-refuted"],
    ["the function handed on can't reach the far end (#491, drizzle)", "src/a.rs#apart", "src/a.rs#again", "calls-backwards"],
    ["the function handed on can't reach the far end, in another file (#491)", "src/a.rs#apart_far", "src/b.rs#target", "calls-refuted"],
  ],
}, 180_000, !hasRustAnalyzer);
