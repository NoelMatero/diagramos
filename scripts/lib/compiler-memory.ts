/**
 * Compiler answers remembered across runs, for the measurements.
 *
 * ## The bad outcome
 *
 * Every bench run and every compiler-true run started pyright and
 * rust-analyzer again for every project and asked them the same tens of
 * thousands of questions about the same pinned clones: what is declared at
 * this name, what type this value has, which class this one derives from. A
 * branch arm asks almost exactly what its base asked the hour before. The
 * servers' own work was a sixth to a third of a Python project's time, and a
 * server that has to start at all costs its whole index.
 *
 * ## What is remembered, and keyed on what
 *
 * The answer one referee method gives (`PyrightLspReferee`,
 * `RustLspReferee`): `methodDeclarationLocationAt(file, source, 120, 131)` ->
 * `{ file, line }`. Not what the checker makes of it -- whether a definition
 * "runs there", which arrow it settles: that is re-read from the answer by
 * the checker of the run, so a branch that changes the checker still reuses
 * every answer its base got.
 *
 * An answer is reused only where everything it rests on is the same, and is
 * asked again otherwise:
 *
 *   - **the question**: the method, the file, the file's text (its hash), the
 *     range, and what else it carries (a `fitsAt` target, a member's name);
 *   - **the tree**: the git commit of the clone the server was started in,
 *     every changed and every untracked file's content, and the libraries
 *     installed for it (the caller says which);
 *   - **the compiler**: pyright's pinned version and the Python first on
 *     `PATH` (it finds the libraries through it); rust-analyzer's and rustc's
 *     versions as rustup picks them for that crate;
 *   - **the asking code**: the board-ai files that put the question and read
 *     the server's reply into an answer (`ASKING`), and the installed
 *     packages they load. A branch that edits one asks everything again.
 *
 * ## What is never remembered
 *
 * A question that failed: it timed out, came back as an error, the server
 * died or never said it was ready. Those read `undefined` -- the same as the
 * compiler's own "nothing here" -- so a "nothing here" is kept only from a
 * server that failed nothing in its whole life and was warm (pyright: its
 * warm-up had a real answer; rust-analyzer: it said it had finished
 * priming). From a server that failed something, only real answers are kept;
 * from a rust-analyzer that never said it was ready, nothing. Two runs that
 * kept different answers to one question void it: it is asked again, and the
 * header counts it.
 *
 * ## How a server is spared
 *
 * The pool (`referee-pool.ts`) starts servers through `wrap`. For a tree
 * that has answers kept, the referee handed out answers what it has and
 * starts the real server -- warm-up and all -- only when a question has no
 * kept answer. A project whose every question was asked before starts no
 * server at all. A tree with nothing kept starts its server at once, exactly
 * as without this file.
 *
 * Measurement only; nothing in the product uses it. `--no-memory` (or
 * `BOARD_AI_COMPILER_MEMORY=off`) turns it off; `--memory=verify` asks every
 * question for real and counts any kept answer the server now contradicts.
 * Kept under `~/.board-ai-compiler-memory` (`BOARD_AI_COMPILER_MEMORY_DIR`),
 * one folder per tree and compiler, one file per run that learnt something.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when what is kept, or how a question is keyed, changes: every earlier answer is then asked again. */
export const MEMORY_FORMAT = 1;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The files that put a question to a server and turn its reply into an
 * answer, with what they load at run time. Type-only imports are left out.
 */
const ASKING: Record<Language, string[]> = {
  python: ["referee-python-lsp.ts", "parse.ts", "recover.ts", "referee-ts.ts", "server-process.ts", "lsp-symbols.ts"],
  rust: ["referee-rust-lsp.ts", "server-process.ts", "lsp-symbols.ts"],
};

type Language = "python" | "rust";
export type MemoryMode = "on" | "off" | "verify";

/** `--no-memory` / `--memory=off|on|verify`, else `BOARD_AI_COMPILER_MEMORY`, else on. */
export function memoryMode(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): MemoryMode {
  if (argv.includes("--no-memory")) return "off";
  const given = argv.find((one) => one.startsWith("--memory="))?.slice("--memory=".length) ?? env.BOARD_AI_COMPILER_MEMORY;
  if (given === undefined || given === "" || given === "on") return "on";
  if (given === "verify") return "verify";
  if (given === "off" || given === "0" || given === "no") return "off";
  throw new Error(`compiler memory: "${given}" is not on, off or verify`);
}

export function memoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOARD_AI_COMPILER_MEMORY_DIR ?? path.join(os.homedir(), ".board-ai-compiler-memory");
}

/** What one process did with the memory, for a run's header. Summed across workers. */
export interface MemoryCounts {
  /** Questions put to a referee through the memory. */
  calls: number;
  /** Of those, answered from what an earlier run kept. */
  remembered: number;
  /** Put to a real server: no kept answer, or every one under `verify`. */
  asked: number;
  /** New answers written for the next run. */
  kept: number;
  /** Answers this run learnt and did not keep: from a server that failed something, or was never ready. */
  notKept: number;
  /** Servers started, and servers a referee was handed out for that never had to start. */
  started: number;
  spared: number;
  /** Questions two earlier runs answered differently: asked again, never reused. */
  conflicts: number;
  /** `verify`: kept answers a live server contradicted. */
  mismatches: number;
}

export const noCounts = (): MemoryCounts => ({
  calls: 0, remembered: 0, asked: 0, kept: 0, notKept: 0, started: 0, spared: 0, conflicts: 0, mismatches: 0,
});

export function addCounts(into: MemoryCounts, from: Partial<MemoryCounts> | undefined): MemoryCounts {
  if (!from) return into;
  for (const name of Object.keys(into) as Array<keyof MemoryCounts>) into[name] += Number(from[name] ?? 0);
  return into;
}

/** The header line: how many answers came from memory, and where it is. */
export function memoryLine(mode: MemoryMode, counts: MemoryCounts, dir = memoryDir()): string {
  if (mode === "off") return "compiler memory: off (--no-memory); every question was asked";
  if (counts.calls === 0) return `compiler memory: ${mode}, but no question went through it (${dir})`;
  const pct = (n: number) => `${Math.round((100 * n) / Math.max(1, counts.calls))}%`;
  return `compiler memory: ${counts.remembered} of ${counts.calls} answers remembered (${pct(counts.remembered)}),`
    + ` ${counts.asked} asked; ${counts.started} server${counts.started === 1 ? "" : "s"} started,`
    + ` ${counts.spared} not needed; ${counts.kept} new answers kept`
    + (counts.notKept > 0 ? `, ${counts.notKept} not kept (a server failed or was not ready)` : "")
    + (counts.conflicts > 0 ? `; ${counts.conflicts} answers two runs disagreed on, asked again` : "")
    + (mode === "verify" ? `; verify: ${counts.mismatches} kept answers contradicted` : "")
    + ` (${dir})`;
}

/* ---------------------------------------------------------------- keys */

const sha1 = (text: string | Buffer): string => createHash("sha1").update(text).digest("hex");

function run(command: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(command, args, {
      cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

/**
 * The state of the git checkout `dir` is in: its commit, and the content of
 * everything changed or untracked. Undefined when `dir` is in no checkout --
 * with no commit to key on, nothing is kept or reused.
 */
export function treeState(dir: string, trees = new Map<string, Record<string, string>>()): Record<string, string> | undefined {
  const git = (at: string, ...args: string[]) => execFileSync("git", ["-C", at, ...args], {
    encoding: "buffer", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"],
  });
  let top: string;
  try {
    top = git(dir, "rev-parse", "--show-toplevel").toString("utf8").trim();
  } catch {
    return undefined;
  }
  const had = trees.get(top);
  if (had) return had;
  let state: Record<string, string>;
  try {
    const commit = git(top, "rev-parse", "HEAD").toString("utf8").trim();
    const hash = createHash("sha1");
    // From the top, every one: a crate's answers rest on its workspace's other crates too.
    hash.update(git(top, "status", "--porcelain=v1", "--untracked-files=all"));
    hash.update(git(top, "diff", "HEAD", "--binary"));
    // An untracked file's name is in the status; its content is what an answer can rest on.
    for (const name of git(top, "ls-files", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean)) {
      hash.update(name);
      try { hash.update(readFileSync(path.join(top, name))); } catch { hash.update("unreadable"); }
    }
    state = { top, commit, tree: hash.digest("hex") };
  } catch {
    return undefined;
  }
  trees.set(top, state);
  return state;
}

let askingHashes: Partial<Record<Language, string>> = {};

/** The asking code (`ASKING`) and the packages it loads, as one hash per language. */
function askingHash(language: Language): string {
  const had = askingHashes[language];
  if (had) return had;
  const hash = createHash("sha1");
  for (const name of ASKING[language]) {
    const file = path.join(REPO, "src", "engine", name);
    hash.update(name);
    hash.update(existsSync(file) ? readFileSync(file) : "missing");
  }
  // The installed packages: the tree-sitter grammars `parse.ts` loads, the JSON-RPC library.
  for (const lock of [path.join(REPO, "node_modules", ".package-lock.json"), path.join(REPO, "package-lock.json")]) {
    if (existsSync(lock)) { hash.update(readFileSync(lock)); break; }
  }
  askingHashes = { ...askingHashes, [language]: hash.digest("hex") };
  return askingHashes[language]!;
}

/** Forget the asking hashes, for a test that edits an asking file. */
export function forgetAskingHashes(): void {
  askingHashes = {};
}

/* -------------------------------------------------------------- storage */

type Kept = { v: unknown } | { u: 1 };

interface Segment { format: number; key: Record<string, string>; answers: Record<string, Kept> }

/** What every run kept for one tree and compiler, merged; a question two runs answered differently is dropped. */
function loadGroup(dir: string): { answers: Map<string, string>; conflicts: number } {
  const answers = new Map<string, string>();
  const voided = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((one) => one.endsWith(".json") && one !== "key.json").sort();
  } catch {
    return { answers, conflicts: 0 };
  }
  for (const name of names) {
    let segment: Segment;
    try {
      segment = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Segment;
    } catch {
      continue; // half written by a run that died: the next run asks those again
    }
    if (segment.format !== MEMORY_FORMAT) continue;
    for (const [question, kept] of Object.entries(segment.answers)) {
      if (voided.has(question)) continue;
      const text = JSON.stringify(kept);
      const had = answers.get(question);
      if (had === undefined) answers.set(question, text);
      else if (had !== text) { answers.delete(question); voided.add(question); }
    }
  }
  return { answers, conflicts: voided.size };
}

/* ------------------------------------------------------------ questions */

/**
 * Every method that asks a server a question, per client, and how its
 * arguments are written into a key: the file's text by its hash, never
 * whole. A method not listed is passed straight to a real server and never
 * remembered.
 */
type KeyOf = (args: unknown[]) => unknown[];
const ranged: KeyOf = (args) => [args[0], sha1(String(args[1])), args[2], args[3]];
const at: KeyOf = (args) => [args[0], sha1(String(args[1])), args[2]];
const symbols: KeyOf = (args) => {
  let text: Buffer | string;
  try { text = readFileSync(String(args[0])); } catch { text = "missing"; }
  return [args[0], sha1(text)];
};
const BOTH: Record<string, KeyOf> = {
  typeDeclarationAt: ranged, typeDeclarationLocationAt: ranged, methodDeclarationAt: ranged,
  methodDeclarationLocationAt: ranged, methodDeclarationOutcomeAt: ranged, typePartsAt: ranged,
  importTargetAt: ranged, documentSymbols: symbols,
};
const QUESTIONS: Record<Language, Record<string, KeyOf>> = {
  python: {
    ...BOTH, valueKindAt: at, ancestorsAt: at,
    fitsAt: (args) => [...ranged(args), args[4]], memberAt: (args) => [...ranged(args), args[4]],
  },
  rust: BOTH,
};

/** What an answer is: a real one, a "nothing here", or a failure (never kept). */
function kindOf(method: string, answer: unknown): "answer" | "nothing" | "failed" {
  if (method === "methodDeclarationOutcomeAt") {
    const outcome = answer as { at?: unknown; none?: unknown; failed?: unknown } | undefined;
    if (outcome && "at" in outcome) return "answer";
    if (outcome && "none" in outcome) return "nothing";
    return "failed";
  }
  return answer === undefined ? "nothing" : "answer";
}

const toKept = (answer: unknown): Kept => (answer === undefined ? { u: 1 } : { v: answer });
const fromKept = (text: string): unknown => {
  const kept = JSON.parse(text) as Kept;
  return "v" in kept ? kept.v : undefined;
};

/* -------------------------------------------------------------- referee */

/** The parts of either client this file needs to see; every other method is passed through. */
interface Client {
  close(): void;
  failures?(): number;
  warmUp?(candidates?: unknown): Promise<void>;
  warmedUp?(): boolean;
  primedCleanly?(): boolean;
  withheldNoType?(): number;
  version?(): string;
  [method: string]: unknown;
}

interface Group {
  language: Language;
  dir: string;
  key: Record<string, string>;
  folder: string;
  kept: Map<string, string>;
  /** Answers this run got from a real server, by question, with what they were. */
  learnt: Map<string, { text: string; kind: "answer" | "nothing" }>;
  real?: Client;
  /** Whether a real server was needed: the referee handed out started one. */
  startedReal: boolean;
  /** A real server was needed and would not start. */
  startFailed?: boolean;
  /** Set once the referee is closed or flushed: what may be kept, judged then. */
  trust?: "all" | "answers" | "nothing";
}

export class CompilerMemory {
  readonly counts: MemoryCounts = noCounts();
  private readonly groups: Group[] = [];
  /** Each checkout's state, read once per run: the trees measured do not change under one. */
  private readonly trees = new Map<string, Record<string, string>>();

  constructor(
    readonly mode: MemoryMode,
    /** What the caller knows the answers also rest on: the libraries installed, by pins and place. */
    private readonly extraKey: Record<string, string> = {},
    readonly dir: string = memoryDir(),
  ) {}

  /**
   * `refereePool`'s `wrap`: the referee the pool hands out for `poolKey`
   * (`python:<root>`, `rust:<crate>`). Off, or a key it cannot key, starts
   * the server as ever.
   */
  readonly wrap = <T>(poolKey: string, start: () => Promise<T>): Promise<T> => {
    if (this.mode === "off") return start();
    const language: Language | undefined = poolKey.startsWith("python:") ? "python" : poolKey.startsWith("rust:") ? "rust" : undefined;
    if (!language) return start();
    const dir = poolKey.slice(language.length + 1);
    const key = this.keyFor(language, dir);
    if (!key) return start();
    const folder = path.join(this.dir, language, sha1(JSON.stringify(key)).slice(0, 20));
    const { answers, conflicts } = loadGroup(folder);
    this.counts.conflicts += conflicts;
    const group: Group = { language, dir, key, folder, kept: answers, learnt: new Map(), startedReal: false };
    this.groups.push(group);
    return this.referee(group, start as unknown as () => Promise<Client>) as unknown as Promise<T>;
  };

  private keyFor(language: Language, dir: string): Record<string, string> | undefined {
    const tree = treeState(dir, this.trees);
    if (!tree) return undefined;
    const key: Record<string, string> = {
      format: String(MEMORY_FORMAT), language, dir: path.resolve(dir), ...tree, asking: askingHash(language), ...this.extraKey,
    };
    if (language === "python") {
      key.compiler = `pyright ${pyrightVersion()}`;
      // pyright finds a project's libraries through whichever Python is first on PATH.
      key.python = run("sh", ["-c", "for p in python python3; do command -v $p && $p --version; done; true"]);
    } else {
      // rustup picks the toolchain per crate, by its rust-toolchain file.
      key.compiler = `${run("rust-analyzer", ["--version"], dir)} | ${run("rustc", ["-vV"], dir)}`;
    }
    return key;
  }

  /** The referee handed out: a real one started now when nothing is kept, else one that starts it on the first question it cannot answer. */
  private async referee(group: Group, start: () => Promise<Client>): Promise<Client> {
    const counts = this.counts;
    let real: Promise<Client> | undefined;
    let warmWith: unknown;
    /** The warm-up every question to a real server waits on, so none is asked before the server is ready. */
    let warming: Promise<void> | undefined;
    const startReal = (): Promise<Client> => {
      real ??= (async () => {
        const client = await start().catch((error: unknown) => { group.startFailed = true; throw error; });
        group.real = client;
        group.startedReal = true;
        counts.started += 1;
        return client;
      })();
      return real;
    };
    /** A real server, warmed the way the asker warmed this referee, before it is asked anything. */
    const ready = async (): Promise<Client> => {
      const client = await startReal();
      if (client.warmUp) {
        warming ??= client.warmUp(warmWith);
        await warming;
      }
      return client;
    };
    const eager = this.mode === "verify" || group.kept.size === 0;
    if (eager) await startReal();

    const questions = QUESTIONS[group.language];
    const ask = (method: string) => async (...args: unknown[]): Promise<unknown> => {
      counts.calls += 1;
      const question = JSON.stringify([method, ...questions[method]!(args)]);
      const kept = group.kept.get(question);
      if (kept !== undefined && this.mode === "on") {
        counts.remembered += 1;
        return fromKept(kept);
      }
      counts.asked += 1;
      const client = await ready();
      const answer = await (client[method] as (...rest: unknown[]) => Promise<unknown>)(...args);
      const kind = kindOf(method, answer);
      if (kind !== "failed") {
        const text = JSON.stringify(toKept(answer));
        if (kept !== undefined && kept !== text) counts.mismatches += 1;
        if (kept === undefined) group.learnt.set(question, { text, kind });
      }
      return answer;
    };

    const handed: Client = {
      close: () => {
        this.judge(group);
        group.real?.close();
      },
      failures: () => group.real?.failures?.() ?? 0,
      // Remembered for when a real server is needed; one already up is warmed as ever.
      warmUp: async (candidates?: unknown) => {
        warmWith = candidates;
        if (group.real?.warmUp) {
          warming = group.real.warmUp(candidates);
          await warming;
        }
      },
      ...(group.language === "python"
        ? {
          warmedUp: () => group.real?.warmedUp?.() ?? true,
          withheldNoType: () => group.real?.withheldNoType?.() ?? 0,
        }
        : {
          primedCleanly: () => group.real?.primedCleanly?.() ?? true,
          version: () => group.real?.version?.() ?? group.key.compiler ?? "unknown",
        }),
    };
    for (const method of Object.keys(questions)) handed[method] = ask(method);
    /* Anything else a client offers goes to a real server, unremembered. */
    return new Proxy(handed, {
      get: (target, name, receiver) => {
        if (typeof name !== "string" || name in target || name === "then") return Reflect.get(target, name, receiver);
        return async (...args: unknown[]) => {
          const client = await ready();
          return (client[name] as (...rest: unknown[]) => unknown)(...args);
        };
      },
    });
  }

  /** What a group's server earned: everything, real answers only, or nothing. Judged once, at close or flush. */
  private judge(group: Group): void {
    if (group.trust) return;
    const real = group.real;
    if (!real) { group.trust = "nothing"; return; }
    const failures = real.failures?.();
    if (failures === undefined) { group.trust = "nothing"; return; } // a client that cannot say what it missed
    const ready = group.language === "python" ? real.warmedUp?.() === true : real.primedCleanly?.() === true;
    if (group.language === "rust" && !ready) group.trust = "nothing";
    else group.trust = failures === 0 && ready ? "all" : "answers";
  }

  /**
   * Write what this process learnt and may keep, one file per tree and
   * compiler, and count the servers that never had to start. Call before
   * the process exits: a pool's own close runs after the caller's next line.
   */
  flush(): MemoryCounts {
    for (const group of this.groups.splice(0)) {
      this.judge(group);
      if (!group.startedReal && !group.startFailed) this.counts.spared += 1;
      const keep: Record<string, Kept> = {};
      let kept = 0;
      for (const [question, { text, kind }] of group.learnt) {
        if (group.trust === "all" || (group.trust === "answers" && kind === "answer")) {
          keep[question] = JSON.parse(text) as Kept;
          kept += 1;
        } else this.counts.notKept += 1;
      }
      if (kept === 0) continue;
      try {
        mkdirSync(group.folder, { recursive: true });
        const keyFile = path.join(group.folder, "key.json");
        if (!existsSync(keyFile)) writeFileSync(keyFile, `${JSON.stringify(group.key, null, 1)}\n`);
        const name = `${String(Date.now()).padStart(15, "0")}-${process.pid}-${randomBytes(3).toString("hex")}.json`;
        const temporary = path.join(group.folder, `.${name}.tmp`);
        writeFileSync(temporary, JSON.stringify({ format: MEMORY_FORMAT, key: group.key, answers: keep } satisfies Segment));
        renameSync(temporary, path.join(group.folder, name));
        this.counts.kept += kept;
      } catch {
        this.counts.notKept += kept; // a full disk loses the next run's head start, never an answer
      }
    }
    return this.counts;
  }
}

/* --------------------------------------------- a referee's whole answer */

/** The content of these repository files, as one hash: the code a remembered value was made by. */
export function filesHash(files: readonly string[]): string {
  const hash = createHash("sha1");
  for (const name of files) {
    const file = path.join(REPO, name);
    hash.update(name);
    hash.update(existsSync(file) ? readFileSync(file) : "missing");
  }
  return hash.digest("hex");
}

/** A command's output for a key (a compiler's version), or "unavailable". */
export const versionOf = (command: string, args: string[], cwd?: string): string => run(command, args, cwd);

/**
 * One whole answer remembered across runs: compiler-true's list of true pairs
 * for a project, which its referee (the TypeScript compiler's API, jedi,
 * rustc's MIR) works out from the project alone. `key` says everything the
 * value rests on -- the checkout's state, the referee's code and version,
 * the options -- and is undefined when it cannot be said (no git checkout):
 * then it is worked out and not kept. `keep` says whether a value may be kept
 * (a referee that could not run has nothing worth keeping). Under `verify`
 * the value is worked out again and compared; under `off`, never read or
 * kept.
 *
 * jedi does not list the same pairs every run (one pydantic call, 2 runs in
 * 10, 2026-11-26), so a remembered list is also what keeps a base and its
 * branch measuring the same population.
 */
export async function remembered<T>(
  mode: MemoryMode, what: string, key: Record<string, string> | undefined,
  compute: () => T | Promise<T>, keep: (value: T) => boolean, dir: string = memoryDir(),
): Promise<{ value: T; remembered: boolean; contradicted?: boolean }> {
  if (mode === "off" || !key) return { value: await compute(), remembered: false };
  const file = path.join(dir, what, `${sha1(JSON.stringify({ format: MEMORY_FORMAT, ...key })).slice(0, 20)}.json`);
  let kept: { format: number; value: T } | undefined;
  try {
    kept = JSON.parse(readFileSync(file, "utf8")) as { format: number; value: T };
    if (kept.format !== MEMORY_FORMAT) kept = undefined;
  } catch { kept = undefined; }
  if (kept && mode === "on") return { value: kept.value, remembered: true };
  const value = await compute();
  if (kept) return { value, remembered: false, contradicted: JSON.stringify(kept.value) !== JSON.stringify(value) };
  if (keep(value)) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ format: MEMORY_FORMAT, key, value }));
      renameSync(temporary, file);
    } catch { /* the next run works it out again */ }
  }
  return { value, remembered: false };
}

let pyright: string | undefined;
function pyrightVersion(): string {
  if (pyright) return pyright;
  const file = path.join(REPO, "src", "engine", "referee-python-lsp.ts");
  pyright = /export const PYRIGHT_VERSION = "([^"]+)"/.exec(existsSync(file) ? readFileSync(file, "utf8") : "")?.[1] ?? "unknown";
  return pyright;
}

/** How much is kept, for `measure:batch`'s header. */
export function memorySize(dir = memoryDir()): { trees: number; bytes: number } {
  let trees = 0;
  let bytes = 0;
  for (const language of ["python", "rust"]) {
    let groups: string[];
    try { groups = readdirSync(path.join(dir, language)); } catch { continue; }
    for (const group of groups) {
      trees += 1;
      try {
        for (const name of readdirSync(path.join(dir, language, group))) bytes += statSync(path.join(dir, language, group, name)).size;
      } catch { /* gone meanwhile */ }
    }
  }
  return { trees, bytes };
}
