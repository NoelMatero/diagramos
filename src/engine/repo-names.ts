/**
 * Every name a file or a directory in this repository goes by (#469).
 *
 * The one question it answers is whether an import that resolved to nothing
 * could still be the repository's own code. A specifier that fails to resolve
 * is usually a library, and sometimes a module the resolver could not reach:
 * a Python package under a directory no import root covers, a Rust crate a
 * 2015-edition path names from the crate root, a bundler alias. In every one
 * of those the first segment is the name of something here. So a first
 * segment that names no file and no directory anywhere in the tree is a
 * library's, whatever the resolver missed.
 *
 * The test is deliberately coarse: `pip/_internal/utils/logging.py` blocks a
 * Python `import logging` it can never shadow. Being wrong that way leaves a
 * call "not sure"; being wrong the other way calls a right arrow wrong.
 *
 * Read once per workspace, lazily. Past the cap it answers `undefined`, which
 * every caller reads as "could be here".
 */
import path from "node:path";

import { NEVER_WALK } from "./generated";
import type { Workspace } from "./workspace";

const NAME_CAP = 200_000;

const known = new WeakMap<Workspace, Set<string> | null>();

/** File stems and directory names under the root, or `undefined` past the cap. */
export function repoNames(workspace: Workspace): ReadonlySet<string> | undefined {
  const cached = known.get(workspace);
  if (cached !== undefined) return cached ?? undefined;
  const root = workspace.resolve(".");
  let names: Set<string> | null = root ? new Set<string>() : null;
  let seen = 0;
  const queue = root ? [root] : [];
  while (names && queue.length > 0) {
    const directory = queue.pop()!;
    for (const entry of workspace.list(directory)) {
      if (entry.startsWith(".") || NEVER_WALK.has(entry)) continue;
      seen += 1;
      if (seen > NAME_CAP) { names = null; break; }
      const child = `${directory}${path.sep}${entry}`;
      const kind = workspace.stat(child);
      if (kind === "directory") {
        names.add(entry);
        queue.push(child);
      } else if (kind === "file") {
        const dot = entry.indexOf(".");
        names.add(dot > 0 ? entry.slice(0, dot) : entry);
        if (entry.endsWith(".d.ts")) {
          const declared = ambient.get(workspace) ?? [];
          for (const match of workspace.read(child).matchAll(/\bdeclare\s+module\s+['"]([^'"]+)['"]/g)) declared.push(match[1]!);
          ambient.set(workspace, declared);
        }
      }
    }
  }
  known.set(workspace, names);
  return names ?? undefined;
}

const ambient = new WeakMap<Workspace, string[]>();

/**
 * Whether a declaration file of this repository's describes the module
 * itself -- `declare module "estree-walker"` in Vue's `global.d.ts`. The
 * code that runs is still the package's, but the compiler's "go to
 * definition" lands on the repository's declaration, and which of the two a
 * box anchored there means is not this reader's to decide, so the module is
 * not read as a library (#469: 13 calls in Vue, excalidraw and Vite).
 * `undefined` past the walk's cap counts as declared.
 */
export function declaredHere(specifier: string, workspace: Workspace): boolean {
  if (repoNames(workspace) === undefined) return true;
  return (ambient.get(workspace) ?? []).some((pattern) => pattern.includes("*")
    ? new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(specifier)
    : pattern === specifier);
}

/** Whether nothing in the repository is called `name`; false when that cannot be told. */
export function namesNothingHere(name: string, workspace: Workspace): boolean {
  const names = repoNames(workspace);
  return names !== undefined && !names.has(name);
}
