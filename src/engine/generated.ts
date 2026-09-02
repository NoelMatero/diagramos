/**
 * Which directories in a repository hold generated files, and how to tell.
 *
 * Two callers with two different stakes, which is why this is one module and
 * not two lists:
 *
 * - **The walks** (`drift.ts` coverage and completeness, `follow.ts`'s
 *   destinations, the rebind measurement) ask "is this worth entering?" A wrong
 *   answer costs a suggestion nobody was promised, so a bare list of directory
 *   names is enough and `NEVER_WALK` is that list.
 * - **The ref check** asks "may a box point here?" A wrong answer there is an
 *   accusation against a ref somebody wrote by hand, so it is not enough that a
 *   directory is *called* `build` — `generatedRef` wants the manifest that
 *   produces it sitting beside it.
 *
 * ## Why a ref into build output has to be refused
 *
 * `workspace.resolve` plus `stat` used to be the whole gate: inside the root and
 * present on disk meant the ref resolved. Nothing distinguished a source file
 * from a compiler's leavings, so a box anchored at
 * `lib_shared/target/debug/.fingerprint/lib_shared-e44f0492/output-test-lib` was
 * reported clean — and went on being reported clean while the function it was
 * meant to describe was renamed, moved and deleted (#166).
 *
 * That is the one failure this project avoids everywhere else: confident silence
 * about something wrong. A ref that cannot resolve is a finding, and findings
 * get fixed. A ref into `target/` passes forever and has nothing to say, ever.
 *
 * ## Why the manifest, and not just the name
 *
 * Because `vendor` is on the list and `src/engine/vendor/browser-shim.ts` is a
 * source file in this very repository. A segment name alone would refuse it, and
 * would keep refusing it no matter what its author did — a red nobody can clear
 * is worse than the green this replaces. A directory beside the `package.json`
 * or `Cargo.toml` that generates it is build output; the same name three levels
 * down inside `src/` is somebody's module.
 *
 * ## Where such a ref came from, which #166 did not answer (#174)
 *
 * Refusing the ref was containment. The other half — how a path nobody typed got
 * into a board file — was split out, and the audit asked of every writer of
 * `customData.ref` whether it can produce a string that was not handed to it:
 *
 * | writer | verdict |
 * | --- | --- |
 * | `create_diagram`, `edit_diagram` | caller's string, stored verbatim. Cleared. |
 * | `promote.ts` | writes `strokeStyle`, `state`, a marker. Never `ref`. Cleared. |
 * | `accept.ts` | writes `customData.edge.from`/`to`. Never `ref`. Cleared. |
 * | `POST /api/board` | the browser's scene, whose refs come from the panel below. |
 * | `repair.ts` | applies `follow.ts`'s `becomes` unread. **Was a hole.** |
 * | `/api/paths` → the anchor panel | offered build output as autocomplete. **Was a hole.** |
 *
 * Both holes were reproduced rather than argued, and both are now filtered:
 *
 * - **The picker offered what the checker refuses.** `/api/paths` lists
 *   `gitKnown`, and `--others` means untracked files nothing ignores — so a Rust
 *   tree with no `.gitignore` for `target/` put its whole build directory in the
 *   panel that exists to stop refs being mistyped. Measured on this repository:
 *   **426 of 656 paths offered were build output**, cargo fingerprint logs among
 *   them, sorted in ahead of the source they were built from. Picking one is a
 *   click and types nothing, which makes it the likeliest account of the original
 *   ref. `board-server.ts` now filters that list through `generatedRef`, so the
 *   picker and the checker answer one question with one piece of code.
 * - **The rename channel could write one.** `follow.ts` filtered its two search
 *   channels from the start and not its rename channel, which is the one whose
 *   answer `repair.ts` applies on sight. A repository that commits its build
 *   output makes cargo's own copy of a source file look like an `R100` to git, so
 *   `git mv src/request.rs target/debug/request.rs` produced exactly the reported
 *   bug: a ref nobody typed, pointing at an artifact. Now filtered by
 *   `inNeverWalk` where the destination is chosen.
 *
 * `follow.ts`'s search channels were checked and were already sound: `git grep`
 * reads tracked files only, and both channels filter `inNeverWalk` on top of that.
 */
import type { Workspace } from "./workspace";

/**
 * Directories a walk never enters: dependencies, build output, VCS, reports.
 *
 * Not a security boundary — `workspace.resolve` is still the only way in and out
 * of the tree. This is about cost and noise. Generated code is not something a
 * diagram was ever going to draw.
 *
 * One entry per language the licence covers, which is the rule this list was
 * missing: every name here was a JavaScript convention until `target` arrived,
 * so the largest directory in any Rust repository was walked in full and its
 * fingerprint files counted as source (#166). Adding a language to `licence.ts`
 * means adding its build directory here.
 */
export const NEVER_WALK: ReadonlySet<string> = new Set([
  // JavaScript and TypeScript.
  "node_modules", "out", "dist", "build", "coverage", "vendor",
  "test-results", "playwright-report",
  // Rust.
  "target",
  /*
   * Python. Three, because Python spreads over all three and the dangerous one
   * is not the obvious one: `__pycache__` holds bytecode a walk should not pay
   * for, but `venv` is a whole interpreter's worth of third-party `.py` files
   * that a reader would happily count as this repository's source. `.venv` and
   * `.tox` are already skipped for starting with a dot; `venv` is not, and it
   * is just as common.
   */
  "__pycache__", "site-packages", "venv",
  // Version control, and this tool's own output.
  ".git", ".corpus", "graphify-out",
]);

/** True when any segment of a repo-relative path names a directory no walk enters. */
export function inNeverWalk(file: string): boolean {
  return file.split(/[\\/]/).some((segment) => NEVER_WALK.has(segment));
}

/**
 * The manifest whose build produces each directory.
 *
 * The corroboration a refusal rests on. `target` beside a `Cargo.toml` is
 * cargo's; `target` inside `src/` is a package somebody wrote. Only directories
 * that a build tool creates are listed — `.git` is not here, because a ref into
 * it is already refused for naming nothing a licence can read, and asking for a
 * manifest beside it would be asking the wrong question.
 */
const PRODUCED_BESIDE: ReadonlyMap<string, string> = new Map([
  ["node_modules", "package.json"],
  ["out", "package.json"],
  ["dist", "package.json"],
  ["build", "package.json"],
  ["coverage", "package.json"],
  ["vendor", "package.json"],
  ["test-results", "package.json"],
  ["playwright-report", "package.json"],
  ["graphify-out", "package.json"],
  ["target", "Cargo.toml"],
]);

/** What a refused ref points into, in the words a report prints. */
export interface GeneratedRef {
  /** The directory segment that is build output, e.g. `target`. */
  directory: string;
  /** That directory as a repo-relative path, so the reader can see which one. */
  path: string;
  /** The manifest sitting beside it, which is the evidence it is generated. */
  manifest: string;
}

/**
 * Where a repo-relative path enters build output, or nothing.
 *
 * Left to right, so the outermost generated directory is the one named: a path
 * through `target/` and then through a vendored `node_modules` inside it is
 * reported as `target`, which is the sentence its author needs to read.
 *
 * Costs nothing on an ordinary ref — no segment matches, so no `stat` is made at
 * all. Only a path that already looks generated pays for the manifest lookups.
 */
export function generatedRef(
  refPath: string,
  workspace: Workspace,
): GeneratedRef | undefined {
  const segments = refPath.split(/[\\/]/).filter((segment) => segment && segment !== ".");
  for (let index = 0; index < segments.length; index += 1) {
    const manifest = PRODUCED_BESIDE.get(segments[index]!);
    if (!manifest) continue;
    const parent = segments.slice(0, index).join("/");
    const beside = parent ? `${parent}/${manifest}` : manifest;
    const absolute = workspace.resolve(beside);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    return {
      directory: segments[index]!,
      path: segments.slice(0, index + 1).join("/"),
      manifest: beside,
    };
  }
  return undefined;
}
