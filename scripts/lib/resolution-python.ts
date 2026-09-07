/**
 * The Python referee for #227: what pyright itself says a receiver's type is.
 *
 * Pyright has no CLI query for "the type of the expression at this position" --
 * `licence-python.ts`'s `--dependencies` mode answers a different question.
 * The standard way around that, and the one this file uses, is `reveal_type`:
 * pyright treats a call to that name as a command rather than a real function,
 * and reports the static type of its argument as an `information` diagnostic
 * -- `Type of "x" is "Config"` -- that `--outputjson` hands back structured,
 * file and line included.
 *
 * So the referee writes a **copy** of the tree with one `reveal_type(<exact
 * receiver text>)` line inserted immediately above every call site being
 * asked about, runs pyright once over the copy, and reads every diagnostic
 * back. Once, not once per site: pyright's own startup and project analysis
 * dwarfs the cost of answering many questions in the same pass, the same
 * reason `licence-python.ts` runs it once for a whole tree rather than once
 * per file.
 *
 * **The copy, not the original.** Nothing here ever writes into the tree
 * being measured -- `fs.cpSync` into a scratch directory first, insertions
 * applied to the copy, the copy deleted when the run ends. A measurement that
 * mutated somebody's checkout to ask it a question would not be a measurement
 * anybody could trust the rest of.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PYRIGHT_VERSION } from "./licence-python";
import { headOfPython } from "./resolution-ts";

export interface PythonTypeAnswer {
  text: string;
  head: string;
}

/** One question: what is the receiver at `[start, end)` in `file`, on `line`? */
export interface ResolutionQuery {
  id: string;
  /** Repo-relative, forward-slashed. */
  file: string;
  /** 1-based, the original line the call site sits on. */
  line: number;
  start: number;
  end: number;
}

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".corpus", "dist", "build", "vendor",
  ".venv", "venv", "__pycache__", ".tox", ".nox", ".mypy_cache", ".pytest_cache",
  "site-packages", ".eggs", "target", "out",
]);

function copyTree(root: string, into: string): void {
  cpSync(root, into, {
    recursive: true,
    filter: (source) => !SKIP_DIRECTORIES.has(path.basename(source)),
  });
}

/**
 * Every query answered in one pyright run, keyed by the caller's own id.
 *
 * A query with no entry in the result is not a refusal in pyright's own
 * vocabulary -- it is a query this harness could not place: the insertion
 * landed somewhere pyright never analysed, or the diagnostic report changed
 * shape. The caller reports that as `unrefereed`, not as a `REFUSED` verdict,
 * because it is a claim about this harness rather than about the receiver.
 */
export function refereePythonTypes(
  root: string,
  sources: Map<string, string>,
  queries: ResolutionQuery[],
): Map<string, PythonTypeAnswer> {
  const answers = new Map<string, PythonTypeAnswer>();
  if (queries.length === 0) return answers;

  /*
   * Real path, immediately. `mkdtempSync` under macOS `tmpdir()` returns a
   * `/var/...` path that is itself a symlink to `/private/var/...`, and
   * pyright's own diagnostics report the resolved, `/private`-prefixed path --
   * the same mismatch `licence.ts` warns about for a symlinked workspace root.
   * Left unfixed, `path.relative` against the unresolved path never matches,
   * every diagnostic fails to map back to a query, and the referee reports
   * every resolved site as unrefereed rather than agreeing with any of them.
   */
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "resolution-py-")));
  try {
    copyTree(root, scratch);

    const byFile = new Map<string, ResolutionQuery[]>();
    for (const query of queries) {
      const list = byFile.get(query.file) ?? [];
      list.push(query);
      byFile.set(query.file, list);
    }

    /** `${scratchRelativeFile}:${1-based final line}` -> query id. */
    const lineToId = new Map<string, string>();

    for (const [file, queriesInFile] of byFile) {
      const source = sources.get(file);
      if (source === undefined) continue;
      const originalLines = source.split("\n");
      const sorted = [...queriesInFile].sort((a, b) => a.line - b.line || a.start - b.start);
      const byOriginalLine = new Map<number, ResolutionQuery[]>();
      for (const query of sorted) {
        const list = byOriginalLine.get(query.line) ?? [];
        list.push(query);
        byOriginalLine.set(query.line, list);
      }

      const output: string[] = [];
      originalLines.forEach((text, index) => {
        const lineNumber = index + 1;
        for (const query of byOriginalLine.get(lineNumber) ?? []) {
          const indent = text.match(/^[ \t]*/)?.[0] ?? "";
          const expr = source.slice(query.start, query.end);
          output.push(`${indent}reveal_type(${expr})`);
          lineToId.set(`${file}:${output.length}`, query.id);
        }
        output.push(text);
      });

      writeFileSync(path.join(scratch, file), output.join("\n"), "utf8");
    }

    const run = spawnSync(
      "npx",
      ["--yes", `pyright@${PYRIGHT_VERSION}`, "--outputjson", "."],
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, cwd: scratch },
    );

    let report: { generalDiagnostics?: Array<{
      file: string;
      severity: string;
      message: string;
      range?: { start: { line: number } };
    }> };
    try {
      report = JSON.parse(run.stdout || "{}");
    } catch {
      throw new Error(
        `pyright's --outputjson output for ${root} did not parse. `
        + `stderr: ${(run.stderr ?? "").split("\n").slice(0, 3).join(" / ")}`,
      );
    }

    for (const diagnostic of report.generalDiagnostics ?? []) {
      if (diagnostic.severity !== "information" || !diagnostic.range) continue;
      const match = /^Type of ".*" is "(.*)"$/s.exec(diagnostic.message);
      if (!match) continue;
      const relative = path.relative(scratch, diagnostic.file).split(path.sep).join("/");
      const line = diagnostic.range.start.line + 1; // pyright reports 0-based.
      const id = lineToId.get(`${relative}:${line}`);
      if (!id) continue;
      const text = match[1]!;
      answers.set(id, { text, head: headOfPython(text) });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return answers;
}
