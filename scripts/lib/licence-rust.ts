/**
 * Measuring the Rust dependency reader against a referee that is not ours.
 *
 * Same argument as the TypeScript harness beside this one, and the same trap
 * avoided: the referee has to answer the hard half itself. For TypeScript the
 * hard half was turning a specifier into a file; for Rust it is the module tree,
 * which no single file contains. `rust.ts` rebuilds that tree out of directory
 * layout, and a second reader of ours agreeing with it would only prove we can
 * be consistently wrong.
 *
 * So the referee is **rust-analyzer**, asked for an LSIF dump. That is the same
 * name resolution an editor does -- written by people who were not us, against
 * the language rather than against our reading of it -- and it needs neither a
 * nightly toolchain nor a successful build, which is what makes measuring five
 * repositories practical at all.
 *
 * **What counts as an edge, on both sides.** A path names a file when it names a
 * *module* that file defines. `use crate::ptr::Own` names two: the crate root,
 * and `ptr`. It does not name wherever `Own` was originally written, and this is
 * the one place the two sides are reconciled: rust-analyzer follows `pub use`
 * re-exports to the item's true home, our reader stops at the module the text
 * spells, and a board is drawn about the second. So references are kept only
 * when the thing referred to is a module -- which rust-analyzer states itself,
 * in the hover text it attaches to every result.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { readDependencies } from "../../src/engine/deps";
import { createWorkspace } from "../../src/engine/drift";
import { initEngine } from "../../src/engine/parse";
import type { LicenceMeasurement } from "./licence";

const SKIP_DIRECTORIES = new Set([
  "target", "node_modules", ".git", ".corpus", "dist", "build", "vendor",
]);

/** Above this, it is generated. */
const TOO_LARGE = 1_000_000;

/**
 * Hover text for a module, as rust-analyzer writes it.
 *
 * `mod x`, `pub mod x`, `pub(crate) mod x`, and `extern crate x` for a crate
 * root reached by name. Matching on the referee's own statement of the kind
 * beats inferring it from coordinates: a definition range that happens to cover
 * a whole file is evidence, a sentence saying `mod` is the answer.
 */
const MODULE_HOVER = /```rust\n(?:pub(?:\([^)]*\))?\s+)?(?:mod|extern crate)\s/;

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
      else if (entry.endsWith(".rs")) {
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
  /** Files the referee opened. Anything else is not in any crate it could see. */
  seen: Set<string>;
}

/** Ask rust-analyzer where every path in the tree points. */
export function refereeEdges(root: string): RefereeResult {
  let dump: string;
  try {
    dump = execFileSync("rust-analyzer", ["lsif", root], {
      encoding: "utf8",
      // A medium crate produces tens of megabytes of JSON lines.
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `rust-analyzer could not index ${root}: ${(error as Error).message.split("\n")[0]}. ` +
        "The Rust licence is measured against rust-analyzer's own name resolution, " +
        "so without it there is no ground truth to compare against.",
    );
  }

  const documentUri = new Map<number, string>();
  const rangeDocument = new Map<number, number>();
  const resultSetOf = new Map<number, number>();
  const definitionOf = new Map<number, number>();
  const hoverOf = new Map<number, number>();
  const hoverText = new Map<number, string>();
  const definitionDocuments = new Map<number, Set<number>>();

  let projectRoot = root;

  for (const line of dump.split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line) as Record<string, any>;
    switch (entry.label) {
      case "metaData":
        projectRoot = decodeURIComponent(String(entry.projectRoot).replace("file://", ""));
        break;
      case "document":
        documentUri.set(entry.id, entry.uri);
        break;
      case "contains":
        for (const range of entry.inVs ?? []) rangeDocument.set(range, entry.outV);
        break;
      case "next":
        resultSetOf.set(entry.outV, entry.inV);
        break;
      case "textDocument/definition":
        definitionOf.set(entry.outV, entry.inV);
        break;
      case "textDocument/hover":
        hoverOf.set(entry.outV, entry.inV);
        break;
      case "hoverResult":
        hoverText.set(entry.id, String(entry.result?.contents?.value ?? ""));
        break;
      case "item":
        // An `item` edge with no `property` is a definition; the ones carrying
        // "references" or "definitions" belong to reference results instead.
        if (entry.property === undefined) {
          let into = definitionDocuments.get(entry.outV);
          if (!into) definitionDocuments.set(entry.outV, (into = new Set()));
          into.add(entry.document);
        }
        break;
      default:
    }
  }

  const relative = (document: number): string | undefined => {
    const uri = documentUri.get(document);
    if (uri === undefined) return undefined;
    const absolute = decodeURIComponent(uri.replace("file://", ""));
    if (!absolute.startsWith(`${projectRoot}/`)) return undefined;
    return path.relative(projectRoot, absolute).split(path.sep).join("/");
  };

  const seen = new Set<string>();
  for (const document of documentUri.keys()) {
    const name = relative(document);
    if (name) seen.add(name);
  }

  const edges = new Set<string>();
  let moduleHovers = 0;
  for (const [range, document] of rangeDocument) {
    const resultSet = resultSetOf.get(range);
    if (resultSet === undefined) continue;
    const definition = definitionOf.get(resultSet);
    if (definition === undefined) continue;
    const from = relative(document);
    if (from === undefined) continue;
    const hover = hoverText.get(hoverOf.get(resultSet) ?? -1) ?? "";
    if (!MODULE_HOVER.test(hover)) continue;
    moduleHovers += 1;
    for (const target of definitionDocuments.get(definition) ?? []) {
      if (target === document) continue;
      const to = relative(target);
      if (to !== undefined) edges.add(`${from} -> ${to}`);
    }
  }

  /*
   * Nothing recognised as a module at all means the hover format moved, not
   * that the repository has no modules. Left unguarded that reads as a perfect
   * score for a reader nobody compared to anything.
   */
  if (moduleHovers === 0 && seen.size > 1) {
    throw new Error(
      `rust-analyzer indexed ${seen.size} files in ${root} and not one path resolved to a module. ` +
        "The hover format this reads has probably changed; the measurement would be meaningless.",
    );
  }

  return { edges, seen };
}

/** The reader and rust-analyzer over the same tree, edge for edge. */
export async function measureRustLicence(root: string): Promise<LicenceMeasurement> {
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
     * A file no crate declares is a file rustc never compiles, so the referee
     * has no opinion about it and neither may we. Counted out loud rather than
     * dropped, because a reader whose sample quietly shrinks to the easy files
     * measures nothing.
     */
    if (!referee.seen.has(file)) {
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
