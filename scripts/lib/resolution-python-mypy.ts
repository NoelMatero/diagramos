import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProbeSite { id: number; start: number; end: number }

/**
 * The alias the probes reach `typing` through.
 *
 * Its own name, rather than `from typing import cast`, so a file that already
 * imports either name is untouched and no probe depends on what the file
 * happens to have imported.
 */
const TYPING = "_dgm_typing";

/** The import line every probed file gets, whatever it already imports. */
export const PROBE_IMPORT = `import typing as ${TYPING}`;

/**
 * The per-site tag, which is what makes a probe's answer findable.
 *
 * mypy prints one note per distinct message per line, so `x.a() + x.b()` --
 * one line, two receivers, one type -- reports once and the second site
 * silently has no answer. A `Literal` carrying the site's own id makes every
 * message distinct, and it means an answer is matched by its id rather than by
 * a line and column, which no longer have to survive the rewrite.
 */
export function probeTagOf(id: number): string {
  return `${TYPING}.cast(${TYPING}.Literal[${id}], 0)`;
}

function opening(id: number): string {
  return `reveal_type((${probeTagOf(id)}, `;
}

const CLOSING = "))[1]";

/**
 * Where the probe import can go: after a module docstring and after any
 * `from __future__` import, which the language requires to come first.
 */
function importLineFor(source: string): number {
  const lines = source.split("\n");
  let at = 0;
  let index = 0;
  let docstring: string | undefined;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    const text = line.trim();
    if (docstring !== undefined) {
      if (text.endsWith(docstring) && !(text === docstring && line.trim().length === docstring.length && index === at)) {
        docstring = undefined;
        at = index + 1;
      }
      continue;
    }
    if (text === "" || text.startsWith("#")) continue;
    const quote = /^(?:[rbuf]{0,2})("""|''')/i.exec(text);
    if (quote && at === index) {
      const mark = quote[1]!;
      const rest = text.slice(text.indexOf(mark) + mark.length);
      if (rest.includes(mark)) { at = index + 1; continue; }
      docstring = mark;
      continue;
    }
    if (/^from\s+__future__\s+import\b/.test(text)) { at = index + 1; continue; }
    break;
  }
  return at;
}

/**
 * Every probe in one pass over the original text, at original offsets, plus
 * the import they need.
 *
 * Receiver ranges nest rather than overlap -- `w.items` inside
 * `w.items.first()` -- and two nested ranges can share a start or an end. So
 * at one offset a closing comes before an opening, closings run innermost
 * first, and openings outermost first.
 */
export function probeSource(source: string, sites: ProbeSite[]): string {
  /* `order` 0 is a closing, 1 an opening; `length` is the whole range's. */
  const events: Array<{ at: number; order: 0 | 1; length: number; text: string }> = [];
  for (const site of sites) {
    const length = site.end - site.start;
    events.push({ at: site.start, order: 1, length, text: opening(site.id) });
    events.push({ at: site.end, order: 0, length, text: CLOSING });
  }
  events.sort((a, b) => a.at - b.at
    || a.order - b.order
    || (a.order === 0 ? a.length - b.length : b.length - a.length));

  let out = "";
  let cursor = 0;
  for (const event of events) {
    out += source.slice(cursor, event.at) + event.text;
    cursor = event.at;
  }
  out += source.slice(cursor);

  const lines = out.split("\n");
  lines.splice(importLineFor(source), 0, PROBE_IMPORT);
  return lines.join("\n");
}

/**
 * The types mypy revealed, by site id.
 *
 * Every note this reads was produced by a probe, and every probe carries its
 * own id in the note's own text -- so nothing is matched by line or column,
 * which the rewrite moves anyway. A note without a tag is not this scan's: it
 * is either mypy's own, or a probe in a body mypy declined to check, which is
 * why the run passes `--check-untyped-defs`.
 */
export function readRevealedTypes(output: string): Map<number, string> {
  const answers = new Map<number, string>();
  for (const line of output.split("\n")) {
    const note = /note: Revealed type is "tuple\[Literal\[(\d+)\], (.+)\]"\s*$/.exec(line);
    if (!note) continue;
    answers.set(Number(note[1]), note[2]!);
  }
  return answers;
}

export interface MypySite {
  id: number;
  /** Absolute path of the source file, inside the tree being measured. */
  file: string;
  start: number;
  end: number;
}

export interface MypyAnswer {
  /** The type mypy printed, qualified the way mypy qualifies it. */
  revealed: string;
  /** The file in the measured tree that declares it, when one does. */
  declaration?: string;
}

export interface MypyReading {
  answers: Map<number, MypyAnswer>;
  /** How mypy was reached, and its version -- part of any number quoted. */
  version: string;
  /** Errors in the tree before any probe. Not zero means answers are a floor. */
  errorsBeforeProbes: number;
  /** mypy could not run at all: no interpreter, a config it rejects. */
  failure?: string;
  /**
   * Dotted names that more than one file in the tree claims, so a revealed
   * type naming one cannot be attributed. Counted rather than guessed at.
   */
  ambiguousModules: string[];
}

/** Never copied: caches, environments, build output, history. */
const COPY_SKIP = new Set([
  ".git", ".mypy_cache", ".venv", "venv", "__pycache__", "node_modules", ".tox", ".pytest_cache",
]);

/**
 * How to run mypy here, or `undefined` when it is not installed.
 *
 * The same stance #237 settled for rust-analyzer and `parse.ts` takes for a
 * missing grammar: no installer, silence when absent. `uvx` is accepted as a
 * second spelling because it is how a machine with `uv` already has mypy
 * without a project-level install -- but nothing here fetches it.
 */
export function mypyCommand(): { command: string; leading: string[] } | undefined {
  for (const candidate of [
    { command: "mypy", leading: [] as string[] },
    { command: "uvx", leading: ["mypy"] },
  ]) {
    try {
      execFileSync(candidate.command, [...candidate.leading, "--version"], {
        stdio: "ignore", timeout: 120_000,
      });
      return candidate;
    } catch { /* try the next spelling */ }
  }
  return undefined;
}

/**
 * Ask mypy what every site's receiver is, by type-checking a probed copy.
 *
 * **The tree is never written to.** It is copied, the probes go into the copy,
 * and mypy's cache lives in a directory of its own -- so a pyright already
 * running against the real tree, and the project's own `.mypy_cache`, are both
 * left alone.
 *
 * Unlike the Rust referee this needs no rounds: a probe is an ordinary
 * expression rather than a compile error, so one run answers every site that
 * mypy checks at all.
 *
 * Two flags are load-bearing rather than tidy:
 *
 * `--check-untyped-defs`, because by default mypy does not look inside a
 * function with no annotations -- and the failure is not a missing answer but
 * a *wrong-shaped* one: the probe reveals a bare `Any`, tag and all, so the
 * site cannot even be identified. Real Python is full of unannotated
 * functions, and without this the corpus quietly shrinks to the annotated half.
 *
 * `--ignore-missing-imports`, because a dependency without stubs is otherwise
 * an error per import; the types it produces are `Any` either way, and this
 * measurement reports `Any` as its own outcome rather than as agreement.
 */
export async function askMypy(
  tree: string,
  files: string[],
  sites: MypySite[],
  options: { workDir?: string } = {},
): Promise<MypyReading> {
  const runner = mypyCommand();
  const empty: MypyReading = {
    answers: new Map(), version: "unknown", errorsBeforeProbes: 0, ambiguousModules: [],
  };
  if (!runner) return { ...empty, failure: "mypy is not on this machine" };

  const realTree = realpathSync(tree);
  const workDir = options.workDir ?? path.join(
    os.tmpdir(), "diagramos-mypy-referee",
    `${path.basename(realTree)}-${createHash("sha1").update(realTree).digest("hex").slice(0, 8)}`,
  );
  mkdirSync(workDir, { recursive: true });
  const realWork = realpathSync(workDir);
  const copy = path.join(realWork, "tree");
  const cacheDir = path.join(realWork, "cache");

  rmSync(copy, { recursive: true, force: true });
  cpSync(realTree, copy, {
    recursive: true,
    filter: (source) => source === realTree || !COPY_SKIP.has(path.basename(source)),
  });

  const inCopy = (file: string) => path.join(copy, path.relative(realTree, realpathSync(file)));
  const listFile = path.join(realWork, "files.txt");
  const readable = files.filter((file) => { try { return statSync(file).isFile(); } catch { return false; } });
  writeFileSync(listFile, readable.map(inCopy).join("\n"));

  const run = (): { output: string; failure?: string } => {
    const result = spawnSync(runner.command, [
      ...runner.leading,
      "--check-untyped-defs", "--ignore-missing-imports", "--no-error-summary",
      "--hide-error-context", "--no-color-output", "--cache-dir", cacheDir,
      `@${listFile}`,
    ], { cwd: copy, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 3_600_000 });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // mypy exits 1 for "found errors", which is the normal case here; only a
    // crash or a rejected configuration leaves no diagnostics at all.
    const crashed = (result.status ?? 0) > 1 || result.error !== undefined;
    return crashed
      ? { output, failure: (result.error?.message ?? output.split("\n").find((line) => line.trim() !== "") ?? "mypy failed").slice(0, 200) }
      : { output };
  };

  const baseline = run();
  if (baseline.failure) return { ...empty, failure: baseline.failure };
  const errorsBeforeProbes = baseline.output.split("\n").filter((line) => /: error: /.test(line)).length;

  const byFile = new Map<string, MypySite[]>();
  for (const site of sites) {
    const file = realpathSync(site.file);
    byFile.set(file, [...(byFile.get(file) ?? []), site]);
  }
  for (const [file, list] of byFile) {
    writeFileSync(inCopy(file), probeSource(readFileSync(file, "utf8"), list));
  }

  const probed = run();
  if (probed.failure) return { ...empty, errorsBeforeProbes, failure: probed.failure };

  /*
   * Indexed over every `.py` file in the copy, not over the files that carry a
   * probe. A type is very often declared in a module with no receiver site of
   * its own, and indexing only the probed files did not merely miss those: the
   * prefix walk below then matched a *shorter* prefix, so
   * `graphify.extractors.models.LanguageConfig` came back declared in
   * `graphify/__init__.py`. A wrong file, quietly, which is worse than none.
   */
  const { modules, ambiguous } = moduleIndexOf(copy, pythonFilesUnder(copy));
  const answers = new Map<number, MypyAnswer>();
  for (const [id, revealed] of readRevealedTypes(probed.output)) {
    const declaring = declaringFileOf(revealed, modules);
    answers.set(id, {
      revealed,
      ...(declaring ? { declaration: path.join(realTree, path.relative(copy, declaring)) } : {}),
    });
  }

  let version = "unknown";
  try {
    version = execFileSync(runner.command, [...runner.leading, "--version"], { encoding: "utf8" }).trim();
  } catch { /* recorded as unknown */ }
  return { answers, version, errorsBeforeProbes, ambiguousModules: ambiguous };
}

/** Every `.py` file under a root, skipping what `COPY_SKIP` already skips. */
function pythonFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try { entries = readdirSync(directory, { withFileTypes: true }).map((one) => one.name); } catch { return; }
    for (const entry of entries) {
      if (COPY_SKIP.has(entry)) continue;
      const full = path.join(directory, entry);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) walk(full);
      else if (entry.endsWith(".py")) found.push(full);
    }
  };
  walk(root);
  return found;
}

/**
 * Every file in the tree, by the dotted name mypy would print for it.
 *
 * A package is a directory holding `__init__.py`, so a file's dotted name is
 * its path from the highest such directory's parent. `graphify/cli.py` under a
 * `graphify/__init__.py` is `graphify.cli`; a loose script in a directory with
 * no `__init__.py` is just its own basename, and two of those in different
 * directories claim the same name -- recorded as ambiguous rather than
 * resolved to whichever came first.
 */
function moduleIndexOf(
  root: string, files: string[],
): { modules: Map<string, string>; ambiguous: string[] } {
  const isPackage = new Map<string, boolean>();
  const packaged = (directory: string): boolean => {
    let known = isPackage.get(directory);
    if (known === undefined) {
      known = existsSync(path.join(directory, "__init__.py"));
      isPackage.set(directory, known);
    }
    return known;
  };

  const modules = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".py")) continue;
    const parts: string[] = [];
    const base = path.basename(file, ".py");
    if (base !== "__init__") parts.push(base);
    let directory = path.dirname(file);
    while (directory.startsWith(root) && packaged(directory)) {
      parts.unshift(path.basename(directory));
      directory = path.dirname(directory);
    }
    const dotted = parts.join(".");
    if (dotted === "") continue;
    const already = modules.get(dotted);
    if (already !== undefined && already !== file) ambiguous.add(dotted);
    else modules.set(dotted, file);
  }
  for (const name of ambiguous) modules.delete(name);
  return { modules, ambiguous: [...ambiguous].sort() };
}

/**
 * The file declaring the type mypy revealed, when the tree holds it.
 *
 * mypy prints a type qualified by its module, and a class nested in another
 * class adds a component -- so the longest prefix that names a file in the
 * tree is the declaring file. Anything else (`builtins.str`, a dependency, a
 * type with no module at all such as `Any` or a callable) is not the tree's,
 * which is a real answer rather than a gap.
 */
function declaringFileOf(revealed: string, modules: Map<string, string>): string | undefined {
  /*
   * A class declared inside a function prints with the line it was declared on
   * -- `tests.test_llm_backends._SubPath@229` -- and the suffix names no module,
   * so without dropping it the class read as declared outside the tree.
   */
  const head = revealed.split("[")[0]!.trim().replace(/\*$/, "").replace(/@\d+$/, "");
  if (!/^[A-Za-z_][\w.]*$/.test(head)) return undefined;
  const parts = head.split(".");
  for (let take = parts.length; take > 0; take--) {
    const file = modules.get(parts.slice(0, take).join("."));
    if (file !== undefined) return file;
  }
  return undefined;
}

/**
 * Types that no file in a repository declares -- the builtins, and mypy's own
 * words for "I have no type here".
 *
 * mypy prints these unqualified and everything else module-qualified, which is
 * what makes the test cheap.
 */
const BUILTIN_TYPES = new Set([
  "Any", "None", "Never", "NoReturn", "object", "type",
  "bool", "int", "float", "complex", "str", "bytes", "bytearray", "memoryview",
  "list", "dict", "set", "frozenset", "tuple", "range", "slice",
  "function", "module", "classmethod", "staticmethod", "property", "super",
]);

/**
 * Whether the type mypy printed is one no file in the tree can declare.
 *
 * This is the shape that separates a naming difference from a wrong file. If
 * mypy says the receiver is a `str` and pyright says its type is declared in
 * one of the project's own files, the two are not two readings of one type --
 * pyright has named a file that cannot be where `str` comes from.
 *
 * Only the outermost type is read, because that is the one a declaring file is
 * about: a `list` of the project's own objects is still declared in typeshed.
 */
export function namesOnlyBuiltins(revealed: string): boolean {
  const heads: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of revealed) {
    if (character === "[" || character === "(") { if (depth === 0) { heads.push(current); current = ""; } depth += 1; continue; }
    if (character === "]" || character === ")") { depth -= 1; continue; }
    if (depth === 0) current += character;
  }
  heads.push(current);
  const named = heads
    .flatMap((part) => part.split("|"))
    .map((part) => part.trim().replace(/[*?]+$/, ""))
    .filter((part) => part !== "");
  if (named.length === 0) return false;
  return named.every((name) => BUILTIN_TYPES.has(name));
}

/**
 * Whether the receiver is a module rather than a value.
 *
 * `import graphify.extract as extract_mod; extract_mod.extract(...)` types as
 * `types.ModuleType` for mypy and resolves to the module's own file for
 * pyright, and **both are right** -- they answer different questions about the
 * same receiver. A board points at a file, so pyright's answer is the useful
 * one; counting it as wrongness would say pyright got wrong the thing it got
 * most right. Classified out for the same reason `declaredByMacro` classifies
 * out a macro-declared type in Rust.
 */
export function isModuleReceiver(revealed: string): boolean {
  const head = revealed.split("[")[0]!.trim();
  return head === "types.ModuleType" || head === "Module";
}
