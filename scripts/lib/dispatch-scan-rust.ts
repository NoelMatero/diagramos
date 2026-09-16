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

/**
 * Build the Rust helper if needed (check timestamps), then run it.
 */
async function buildAndRunHelper(files: string[]): Promise<Record<string, string[]>> {
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
 * Extract case labels from Rust files using the syn-based helper.
 *
 * Processes multiple files in one invocation for efficiency.
 */
export async function labelsInRust(files: string[]): Promise<Record<string, string[]>> {
  if (files.length === 0) return {};
  return buildAndRunHelper(files);
}
