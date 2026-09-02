/**
 * Measuring the Python dependency reader against a referee that is not ours.
 *
 * Same argument as the two harnesses beside this one, and the same trap
 * avoided: the referee has to answer the hard half itself. For TypeScript the
 * hard half was turning a specifier into a file; for Rust it was the module
 * tree. For Python it is `sys.path` -- a runtime value that decides what `import
 * a.b` even means, and which `deps-python.ts` guesses at with two directories.
 *
 * So the referee is **pyright**, run with `--dependencies --verbose`, which
 * prints the import graph it resolved: for every file it analysed, the files
 * that file's imports actually landed on. That is a real type checker's own
 * resolution, written by people who were not us, and it needs no virtualenv, no
 * installed dependencies and no successful run of the code -- which is what
 * makes measuring several repositories practical at all.
 *
 * **Why not mypy.** It resolves too, and its import resolution is configuration
 * sensitive in a way that would have to be pinned per repository; a referee
 * whose answer depends on a config file somebody wrote for their own CI is not
 * ground truth, it is a second opinion. Pyright answers the same way for a bare
 * clone as it does for a configured one, and a bare clone is what a licence is
 * measured over.
 *
 * **What counts as an edge, on both sides.** Python's binding rule, which
 * `deps-python.ts` documents in full: `import a.b.c` names three files because
 * it binds `a`; `import a.b.c as x` names one because it binds `x`; `from a.b
 * import name` names the package, and `name` too when that is a module. Only
 * files inside the tree count -- typeshed and site-packages are not anybody's
 * repository -- and a `.pyi` stub is dropped rather than counted, because a
 * board is drawn about code.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { readDependencies } from "../../src/engine/deps";
import { createWorkspace } from "../../src/engine/drift";
import { initEngine } from "../../src/engine/parse";
import type { LicenceMeasurement } from "./licence";

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".corpus", "dist", "build", "vendor",
  ".venv", "venv", "__pycache__", ".tox", ".nox", ".mypy_cache", ".pytest_cache",
  "site-packages", ".eggs",
]);

/** Above this, it is generated. */
const TOO_LARGE = 1_000_000;

/**
 * The pyright to measure against, pinned.
 *
 * A referee that floats is a number that cannot be reproduced: pyright's
 * resolution improves, and a licence measured against "whatever npx fetched
 * today" is a claim about a day rather than about a reader.
 */
export const PYRIGHT_VERSION = "1.1.406";

function sourceFiles(root: string): { files: string[]; oversized: string[] } {
  const files: string[] = [];
  const oversized: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(directory, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (info.isDirectory()) walk(full);
      else if (entry.endsWith(".py")) {
        if (info.size > TOO_LARGE) oversized.push(relative);
        else files.push(relative);
      }
    }
  };
  walk(root);
  return { files: files.sort(), oversized: oversized.sort() };
}

interface RefereeResult {
  /** `from -> to`, both repo-relative. */
  edges: Set<string>;
  /** Files the referee listed at all, which is what an edge may point at. */
  seen: Set<string>;
  /**
   * Files the referee actually resolved the imports of.
   *
   * Not the same as `seen`, and the difference is the whole of pydantic's
   * measurement. A project's own `[tool.pyright]` may exclude part of its tree
   * -- pydantic excludes `pydantic/v1`, 123 files -- and those files still
   * appear in the report, listed as importing *nothing at all*. Read as zero
   * edges that is a referee stating an absence; it is a referee that never
   * looked, and every real import in those files scores as an invention.
   *
   * A bound file always imports something, because pyright gives every one of
   * them `builtins.pyi`. So an empty import list is the signal, and a file
   * carrying it is counted out loud as unmeasured rather than compared against.
   */
  bound: Set<string>;
}

/**
 * The report `--dependencies --verbose` prints, parsed.
 *
 * The shape is one paragraph per file: the repo-relative name on its own line,
 * then ` Imports N files` and one indented `file://` URI per import, then
 * ` Imported by N files` and the same again. Only the first list is read --
 * the second is the same edges backwards, and taking both would double every
 * disagreement.
 */
function parseDependencies(output: string, root: string): RefereeResult {
  const edges = new Set<string>();
  const seen = new Set<string>();
  const bound = new Set<string>();

  const inside = (uri: string): string | undefined => {
    if (!uri.startsWith("file://")) return undefined;
    /*
     * The path as the referee wrote it, never its real path.
     *
     * Resolving symlinks here looks like tidying and is a way to invent a
     * disagreement out of nothing: pydantic keeps `tests/pydantic_core` as a
     * link into a sibling checkout, and putting the referee's answer through
     * `realpath` renamed it to `pydantic-core/tests` while the reader went on
     * calling it what the repository calls it. Ninety-five edges, counted once
     * as missed and once as invented, and the reader had every one of them
     * right.
     */
    const absolute = decodeURIComponent(uri.slice("file://".length));
    if (!absolute.startsWith(`${root}/`)) return undefined;
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    // Stubs describe code rather than being it, and a board is drawn about the
    // code. The reader never points at one either, so dropping it here keeps
    // both sides meaning the same thing.
    return relative.endsWith(".py") ? relative : undefined;
  };

  let current: string | undefined;
  let collecting: "imports" | "importedBy" | undefined;

  for (const line of output.split("\n")) {
    if (line.startsWith("    file://")) {
      if (collecting === "imports" && current) {
        // Any import at all, typeshed included, is proof the referee bound this
        // file and therefore has an opinion about what is absent from it.
        bound.add(current);
        const target = inside(line.trim());
        if (target && target !== current) edges.add(`${current} -> ${target}`);
      }
      continue;
    }
    if (line.startsWith(" Imports ")) {
      collecting = "imports";
      continue;
    }
    if (line.startsWith(" Imported by ")) {
      collecting = "importedBy";
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t") || line.trim() === "") continue;

    /*
     * Anything else unindented starts a new paragraph, and *every* one of them
     * has to move `current` -- including the ones this does not want.
     *
     * The report covers typeshed stubs and files above the root as well, and
     * they are headed by a `.pyi` name or a `../..` path. Recognising only the
     * headers worth keeping would leave `current` pointing at the previous
     * file, and that file would silently be credited with typeshed's imports:
     * a paragraph of invented edges, attributed to a real file, in the
     * direction that makes the reader look worse than it is.
     */
    const header = line.trim();
    current = header.endsWith(".py") && !header.startsWith("..") ? header : undefined;
    if (current) seen.add(current);
    collecting = undefined;
  }

  return { edges, seen, bound };
}

/** Ask pyright which file every import in the tree landed on. */
export function refereeEdges(root: string): RefereeResult {
  /*
   * Both streams, joined.
   *
   * The dependency report goes to **stderr**: pyright writes it through the
   * same verbose console as its progress logging, and only the diagnostic
   * summary reaches stdout. Reading stdout alone returns a report with no
   * paragraphs in it, which is not an error anywhere -- it is a referee with
   * no edges, and a referee with no edges scores the reader as inventing
   * everything.
   */
  const run = spawnSync(
    "npx",
    ["--yes", `pyright@${PYRIGHT_VERSION}`, "--dependencies", "--verbose", "."],
    {
      encoding: "utf8",
      // The report is one paragraph per file and a large repository has
      // thousands.
      maxBuffer: 1024 * 1024 * 1024,
      cwd: root,
    },
  );
  /*
   * A non-zero exit is normal and says nothing about import resolution --
   * pyright exits 1 whenever the code it analysed has type errors, which most
   * real repositories do. So the report is judged by whether it is there.
   */
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (!output.includes(" Imports ")) {
    throw new Error(
      `pyright could not analyse ${root}: ${run.error?.message ?? (run.stderr ?? "").split("\n")[0]}. ` +
        "The Python licence is measured against pyright's own import resolution, " +
        "so without it there is no ground truth to compare against.",
    );
  }

  const result = parseDependencies(output, realpathSync(root));

  /*
   * No file recognised at all means the report format moved, not that the
   * repository has no Python in it. Left unguarded that reads as a perfect
   * score for a reader nobody compared to anything -- the same guard the Rust
   * harness carries, and for the same reason.
   */
  if (result.bound.size === 0) {
    throw new Error(
      `pyright analysed ${root} and this read no resolved imports out of its dependency report. ` +
        "The report format has probably changed; the measurement would be meaningless.",
    );
  }
  return result;
}

/** The reader and pyright over the same tree, edge for edge. */
export async function measurePythonLicence(root: string): Promise<LicenceMeasurement> {
  const ROOT = realpathSync(path.resolve(root));
  await initEngine();
  const workspace = createWorkspace(ROOT);
  const { files, oversized } = sourceFiles(ROOT);
  const referee = refereeEdges(ROOT);

  const ourEdges = new Set<string>();
  const skipped: string[] = [];
  const incomplete: string[] = [];
  const dynamic: string[] = [];
  const unloaded: string[] = [];
  const measured: string[] = [];
  const configs = new Map();

  for (const file of files) {
    /*
     * A file pyright never analysed is one it has no opinion about, so
     * comparing against it would be comparing against silence. Counted out
     * loud rather than dropped: a reader whose sample quietly shrinks to the
     * files the referee found easy measures nothing.
     */
    if (!referee.bound.has(file)) {
      unloaded.push(file);
      continue;
    }
    const absolute = workspace.resolve(file);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    let source: string;
    try {
      source = workspace.read(absolute);
    } catch {
      continue;
    }
    measured.push(file);

    const read = readDependencies(file, source, workspace, configs);
    if (!read) {
      skipped.push(file);
      continue;
    }
    if (!read.complete) incomplete.push(file);
    if (read.dynamic.length > 0) dynamic.push(file);
    for (const dependency of read.dependencies) {
      if (!dependency.file || dependency.file === file) continue;
      if (referee.seen.has(dependency.file)) ourEdges.add(`${file} -> ${dependency.file}`);
    }
  }

  /* The referee's edges out of a file we never read are not ours to miss. */
  const readable = new Set(measured);
  const refereeKept = new Set(
    [...referee.edges].filter((edge) => {
      const [from, to] = edge.split(" -> ");
      return readable.has(from!) && referee.seen.has(to!) && !skipped.includes(from!);
    }),
  );

  return {
    root: ROOT,
    files: measured,
    skipped,
    unloaded,
    oversized,
    refereeEdges: refereeKept,
    ourEdges,
    missed: [...refereeKept].filter((edge) => !ourEdges.has(edge)).sort(),
    invented: [...ourEdges].filter((edge) => !refereeKept.has(edge)).sort(),
    incomplete,
    dynamic,
  };
}
