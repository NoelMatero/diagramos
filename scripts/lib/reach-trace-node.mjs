/**
 * The run-time half of the TypeScript referee: which of a repository's own
 * routines called which, while its own test suite ran (#273).
 *
 * Loaded as a vitest setup file, one copy per worker, and writes one file per
 * process into `REACH_OUT_DIR`. `scripts/trace-reach.mts` merges them into the
 * record `measure:door-reach --trace=` reads, the same shape
 * `scripts/lib/reach_trace.py` writes for Python.
 *
 * ## Who called whom is read off the real stack, and that is the whole point
 *
 * `reach-trace-plugin.mjs` puts a hook at the top of every function body. The
 * hook does not say who called it -- it captures the JS stack and walks it for
 * the nearest frame that is a routine of this repository, passing through
 * library, test and anonymous frames and marking the edge `through`. So a
 * callback a framework fires is an edge from whoever handed it over, which is
 * the shape no reader here follows and the reason this is a referee.
 *
 * The alternative -- a shadow stack pushed and popped by the hook -- is cheaper
 * and **wrong in Node**: an `await` unwinds the stack while the function is
 * still on the shadow one, so every edge recorded until it resumes is attributed
 * to a function that is not running. A referee that invents an edge invents a
 * false accusation to go with it, which is worse than seeing nothing.
 *
 * ## What it cannot see, so no silence here is evidence
 *
 * - **Anything the tests did not run.** Every run-time referee has this limit.
 * - **An edge across an `await`.** When a continuation resumes there is no
 *   caller on the stack at all, so the edge is dropped rather than guessed.
 * - **An edge out of module initialisation.** The plugin brackets each module,
 *   and an unnamed frame in a file that is still initialising ends the walk:
 *   `reach_trace.py` drops those too, because no routine called it.
 * - **An edge through a frame V8 gives no name.** An unnamed frame inside a file
 *   that is *not* initialising is passed through, so a callback still resolves
 *   to whoever handed it over.
 * - **An inlined call.** V8 can inline a small callee into its caller; the hook
 *   still runs, so the edge survives -- but a frame that has been elided on the
 *   way to it does not appear, and the edge is attributed one routine further
 *   out. It is marked `through` either way.
 */
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";

import { afterAll } from "vitest";

/**
 * A path that is not a repository's own source: a test is not something anybody
 * draws an arrow from. Its own judgement, not the reader's -- and not the
 * plugin's either, so that the referee decides what a routine is even where the
 * plugin instrumented more than that.
 */
const NOT_SOURCE = /(^|\/)(__tests__|__mocks__|test|tests|testing|e2e|spec|docs|doc|examples?|samples?|benchmarks?|bench|fixtures|scripts|dist|build|node_modules)(\/|$)|\.(test|spec|bench|d)\.[cm]?[jt]sx?$/;

/*
 * A vitest worker is reused across test files and is not always let go of
 * cleanly, so the record is rewritten whole after every file rather than once at
 * the end. The first run of this dropped everything: `process.on("exit")` never
 * fired in the worker.
 */
afterAll(() => globalThis.__reachFlush?.());

if (!globalThis.__reachInstalled) {
  globalThis.__reachInstalled = true;
  install();
}

function install() {
  const root = realpathSync(process.env.REACH_ROOT);
  const outDir = process.env.REACH_OUT_DIR;
  /** `64,1024`: record the first 64 entries of a routine, then one in 1,024. Unset records every one. */
  const sample = (process.env.REACH_SAMPLE ?? "").split(",").map(Number);
  const [eager, every] = sample.length === 2 && sample.every((one) => one > 0) ? sample : [Infinity, 1];
  const debug = Number(process.env.REACH_DEBUG ?? 0);

  /** Every file the plugin instrumented, in the order this process loaded them. */
  const files = [];
  const initialising = new Set();
  /** `fromFile|fromName|fromLine|toFile|toName|toLine|through` -> times recorded. */
  const edges = new Map();
  let dropped = 0;
  let debugged = 0;

  const relativeOf = new Map();
  /** A repository source file's path relative to the root, or "" for anything else. */
  function repoFile(url) {
    if (!url) return "";
    let hit = relativeOf.get(url);
    if (hit !== undefined) return hit;
    hit = "";
    const clean = url.replace(/^file:\/\//, "").replace(/[?#].*$/, "");
    if (path.isAbsolute(clean) && clean.startsWith(root + path.sep)) {
      let real = clean;
      try { real = realpathSync(clean); } catch { /* a generated module with no file */ }
      const relative = real.startsWith(root + path.sep) ? real.slice(root.length + 1) : "";
      if (relative && !NOT_SOURCE.test(relative)) hit = relative;
    }
    relativeOf.set(url, hit);
    return hit;
  }

  /*
   * A file the plugin instrumented is a repository source file by construction;
   * one it did not may still be, so `repoFile` decides and the instrumented set
   * is only consulted for whether the file is still initialising. Keeping the
   * two apart is what stops the plugin's own idea of a source file from becoming
   * the referee's.
   */
  globalThis.__reachFile = (relative, lines) => {
    initialising.add(relative);
    files.push({ relative, lines, counts: new Int32Array(lines.length) });
    return files.length - 1;
  };
  globalThis.__reachDone = (relative) => { initialising.delete(relative); };

  const frames = (error, callSites) => callSites;

  /*
   * The hook must never run inside itself. Nothing here calls instrumented code
   * on purpose, but the runtime was once copied somewhere the plugin
   * instrumented it, and the failure was 183 files deep in `Maximum call stack
   * size exceeded` rather than anything that named the cause.
   */
  let inside = false;

  /** Named, because it is the frame `captureStackTrace` is told to cut the stack at. */
  const hook = (fileIndex, index) => {
    if (inside) return;
    const file = files[fileIndex];
    if (file === undefined) return;
    const seen = ++file.counts[index];
    if (seen > eager && seen % every !== 0) return;
    inside = true;
    try { record(file, index); } finally { inside = false; }
  };
  globalThis.__reach = hook;

  function record(file, index) {
    /*
     * A project may own `Error.prepareStackTrace` itself -- vite's module runner
     * installs one to apply source maps -- and then this assignment does
     * nothing and `holder.stack` comes back as somebody else's shape. Checking
     * costs one `Array.isArray`; not checking threw `getFileName is not a
     * function` out of nine of vite's suites.
     */
    const previousPrepare = Error.prepareStackTrace;
    const previousLimit = Error.stackTraceLimit;
    let stack;
    try {
      Error.prepareStackTrace = frames;
      Error.stackTraceLimit = 64;
      const holder = {};
      // Cut at the hook, not at `record`: everything from there up goes, so the
      // first frame left is the function that was entered.
      Error.captureStackTrace(holder, hook);
      stack = holder.stack;
    } catch { /* a frozen Error, which one of vite's tests arranges on purpose */ } finally {
      Error.prepareStackTrace = previousPrepare;
      Error.stackTraceLimit = previousLimit;
    }
    if (!Array.isArray(stack) || typeof stack[0]?.getFileName !== "function") { dropped += 1; return; }

    if (debug > 0 && debugged < debug) {
      debugged += 1;
      const shown = stack.slice(0, 8).map((one, at) =>
        `      [${at}] name=${JSON.stringify(one.getFunctionName())} method=${JSON.stringify(one.getMethodName?.())} `
        + `type=${JSON.stringify(one.getTypeName?.())} file=${one.getFileName()}:${one.getLineNumber()}`);
      appendFileSync(`${outDir}/frames.log`, `hook ${file.relative}[${index}]\n${shown.join("\n")}\n`);
    }

    // The hook is hidden, so the callee is the first frame.
    const calleeFile = repoFile(stack[0]?.getFileName());
    const calleeName = stack[0] && nameOf(stack[0]);
    if (!calleeFile || !calleeName) { dropped += 1; return; }

    let through = false;
    let caller;
    for (let at = 1; at < stack.length; at += 1) {
      const file_ = repoFile(stack[at].getFileName());
      const name = nameOf(stack[at]);
      if (file_ && name) { caller = { file: file_, name }; break; }
      // An unnamed frame in a file that is still running its imports is that
      // module's own initialisation: nothing called it.
      if (file_ && initialising.has(file_)) break;
      through = true;
    }
    if (!caller) { dropped += 1; return; }

    const key = `${caller.file}|${caller.name}|0|${calleeFile}|${calleeName}|${file.lines[index] ?? 0}|${through ? 1 : 0}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }

  /**
   * What a frame's routine is called, in the language's own words.
   *
   * V8 reports a constructor frame under the class's name; the declaration says
   * `constructor`, which is what a reader of the source sees and therefore what
   * `reach_trace.py`'s `__init__` is the Python equivalent of.
   */
  function nameOf(frame) {
    if (frame.isConstructor?.()) return "constructor";
    const name = frame.getFunctionName();
    // V8 reports an accessor as `get doubled`; the declaration says `doubled`.
    if (name && (name.startsWith("get ") || name.startsWith("set "))) return name.slice(4);
    return name;
  }

  function flush() {
    if (edges.size === 0) return;
    mkdirSync(outDir, { recursive: true });
    const out = {
      root,
      files: [...new Set(files.map((one) => one.relative))],
      dropped,
      edges: [...edges].map(([key, count]) => {
        const [fromFile, fromName, fromLine, toFile, toName, toLine, through] = key.split("|");
        return [fromFile, fromName, Number(fromLine), toFile, toName, Number(toLine), through === "1", count];
      }),
    };
    writeFileSync(`${outDir}/part-${process.pid}-${threadId}.json`, JSON.stringify(out));
  }

  globalThis.__reachFlush = flush;
  process.on("exit", flush);
}
