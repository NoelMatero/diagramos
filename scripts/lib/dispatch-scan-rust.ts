/**
 * A referee for Rust `@handles`: match arm case labels read with `syn` parser.
 *
 * This replaces the line-based dispatch-scan.ts referee for Rust, which has
 * three known blind spots (rustfmt breaks, macro_rules! arms, strings) that
 * produce ~3.55%-5.56% disagreement, outside the trust band.
 *
 * This referee uses the `syn` crate's `ExprMatch` visitor to walk the actual
 * AST, producing a second independent reading of arm cases. It shares no
 * machinery with the tree-sitter reader in src/engine/handles.ts.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** One `match` as the `syn` parse reads it, apart from the others in its file. */
export interface RustDispatch {
  /** The matched expression as a token stream prints it: `self . state`. */
  subject: string;
  cases: string[];
  /** 1-based line of the `match` keyword. */
  line: number;
  /**
   * The `fn` this `match` is written inside, per `syn`. Absent for a `match`
   * outside any function.
   *
   * Reported by the referee rather than worked out from line ranges: bounding
   * a routine by the next one a line scan happened to find mis-attributed
   * every dispatch in a gap, and a correct reading of the real routine then
   * read as a disagreement (#310).
   */
  routine?: string;
}

export interface RustFileReading {
  /** Every label in the file, in source order. */
  cases: string[];
  /** The same labels, grouped by the `match` they belong to (#310). */
  dispatches: RustDispatch[];
}

/**
 * Build the Rust helper if needed (check timestamps), then run it.
 */
async function buildAndRunHelper(files: string[]): Promise<Record<string, RustFileReading>> {
  const currentDir = path.dirname(import.meta.url.replace("file://", ""));
  const helperDir = path.resolve(currentDir, "../rust/matcharm-reader");
  const binaryPath = path.join(helperDir, "target/release/matcharm-reader");

  try {
    // Try to build if the binary doesn't exist or is stale
    const needsBuild = !existsSync(binaryPath) ||
      statSync(binaryPath).mtime < statSync(path.join(helperDir, "Cargo.toml")).mtime;

    if (needsBuild) {
      console.error("Building Rust helper...");
      execSync("cargo build --release", {
        cwd: helperDir,
        stdio: "inherit",
      });
    }

    // Write file paths to stdin for the helper
    const input = files.join("\n");
    const result = execSync(binaryPath, {
      input,
      encoding: "utf8",
    });

    return JSON.parse(result);
  } catch (error) {
    console.error("Error running Rust helper:", error);
    // Return empty map on error
    return {};
  }
}

/**
 * Case labels grouped by the `match` they sit in, per file.
 *
 * The grouping is the point. A flat per-file list answers "does the reader
 * invent or lose a label", which is the licence question `measure-handles`
 * asks. It cannot answer "does a box naming one dispatch get that dispatch
 * judged", because with two `match`es in one bag a correct claim about one of
 * them looks like a claim missing half its cases (#310).
 */
export async function dispatchesInRust(files: string[]): Promise<Record<string, RustFileReading>> {
  if (files.length === 0) return {};
  return buildAndRunHelper(files);
}

/** The flat per-file reading, out of the grouped one. */
export const flatten = (readings: Record<string, RustFileReading>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(readings).map(([file, reading]) => [file, reading.cases]));

/**
 * Extract case labels from Rust files using the syn-based helper.
 *
 * Processes multiple files in one invocation for efficiency.
 */
export async function labelsInRust(files: string[]): Promise<Record<string, string[]>> {
  return flatten(await dispatchesInRust(files));
}
