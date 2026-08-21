/**
 * Running both dependency channels over a tree and diffing them.
 *
 * The regex channel in `drift.ts` is what has always corroborated arrows;
 * `deps.ts` parses the grammar instead. Comparing them is how the reader earns
 * the right to be believed, and it is the measurement step 3 turns into a
 * committed licence.
 *
 * Here rather than in the script so `scripts/measure-deps.mts` and the test
 * assert on one implementation instead of two that could drift apart.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { readDependencies, type DynamicReason } from "../../src/engine/deps";
import { createWorkspace, regexImports } from "../../src/engine/drift";
import { initEngine } from "../../src/engine/parse";

export interface DependencyMeasurement {
  root: string;
  files: string[];
  /** Files with no grammar, which the reader is silent about by design. */
  noGrammar: string[];
  /** `file -> file` edges, as each channel sees them. */
  fromRegex: Set<string>;
  fromReader: Set<string>;
  /** Edges only one of them found. The two directions mean opposite things. */
  onlyRegex: string[];
  onlyReader: string[];
  /** Files tree-sitter had to recover from, so nothing can be proved absent in them. */
  incomplete: string[];
  /** Files that reach out at runtime, with the reasons. */
  dynamic: Array<{ file: string; reasons: DynamicReason[] }>;
}

/**
 * Everything a check would never read anyway.
 *
 * `/vendor` is the two 13 MB Excalidraw bundles `build-vendor.mjs` writes on
 * install -- generated, gitignored, and nobody's source. Measuring a reader
 * against minified output says nothing about whether it can read code.
 */
const SKIP = new Set([
  "node_modules", ".git", "out", "graphify", "graphify-out", ".claude",
  // Somebody else's repositories, cloned by `npm run measure:licence`. Walking
  // into them turns a measurement of this tree into a measurement of five others.
  ".corpus",
]);

/**
 * Only the one at the root. `.gitignore` writes it `/vendor/` and says why: an
 * unanchored `vendor` also swallows `src/engine/vendor/`, which is hand-written
 * source and the build's input rather than its output.
 */
const GENERATED = "vendor";
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

function walk(ROOT: string, directory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(directory, entry);
    const relative = path.relative(ROOT, full).split(path.sep).join("/");
    if (relative === GENERATED) continue;
    if (statSync(full).isDirectory()) walk(ROOT, full, into);
    else if (SOURCE.test(entry)) into.push(relative);
  }
  return into;
}


/** Both channels over every source file under `root`. */
export async function measureDependencies(root: string): Promise<DependencyMeasurement> {
  const ROOT = path.resolve(root);
  await initEngine();
  const workspace = createWorkspace(ROOT);
  const files = walk(ROOT, ROOT).sort();

  const fromRegex = new Set<string>();
  const fromReader = new Set<string>();
  const noGrammar: string[] = [];
  const incomplete: string[] = [];
  const dynamic: Array<{ file: string; reasons: DynamicReason[] }> = [];
  const configs = new Map();

  for (const file of files) {
    const absolute = workspace.resolve(file);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    const source = workspace.read(absolute);

    for (const found of regexImports(absolute, file, workspace)) {
      fromRegex.add(`${file} -> ${found.rel}`);
    }

    const read = readDependencies(file, source, workspace, configs);
    if (!read) {
      noGrammar.push(file);
      continue;
    }
    if (!read.complete) incomplete.push(file);
    if (read.dynamic.length > 0) dynamic.push({ file, reasons: read.dynamic });
    for (const dependency of read.dependencies) {
      if (dependency.file) fromReader.add(`${file} -> ${dependency.file}`);
    }
  }

  return {
    root: ROOT,
    files,
    noGrammar,
    fromRegex,
    fromReader,
    onlyRegex: [...fromRegex].filter((edge) => !fromReader.has(edge)).sort(),
    onlyReader: [...fromReader].filter((edge) => !fromRegex.has(edge)).sort(),
    incomplete,
    dynamic,
  };
}
