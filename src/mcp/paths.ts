/**
 * Path confinement for the board server.
 *
 * Every tool takes a file path from the model, so all of them have to resolve
 * through here. The root defaults to the working directory and can be pinned
 * with DIAGRAMOS_MCP_ROOT; anything resolving outside it is refused, symlinks
 * included.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

import { CONFIG_FILE, diagramDir } from "../engine/config";

function realOrResolved(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export const WORKSPACE_ROOT = realOrResolved(process.env.DIAGRAMOS_MCP_ROOT ?? process.cwd());

function isInsideRoot(target: string): boolean {
  const relative = path.relative(WORKSPACE_ROOT, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a caller-supplied path inside the workspace. Checks the nearest
 * existing ancestor's real path too, so a symlinked parent directory cannot be
 * used to escape.
 */
export function resolveInWorkspace(candidate: string): string {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error("A file path is required");
  }
  const resolved = path.resolve(WORKSPACE_ROOT, candidate);
  if (!isInsideRoot(resolved)) {
    throw new Error(`Path escapes the workspace root (${WORKSPACE_ROOT}): ${candidate}`);
  }
  // Walk up to the first directory that exists and confirm its real location
  // is still inside the root before trusting the full path.
  let ancestor = resolved;
  while (ancestor !== path.dirname(ancestor)) {
    const real = realOrResolved(ancestor);
    if (real !== ancestor) {
      if (!isInsideRoot(real)) {
        throw new Error(`Path resolves outside the workspace via a symlink: ${candidate}`);
      }
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  return resolved;
}

export function relativeToWorkspace(target: string): string {
  return path.relative(WORKSPACE_ROOT, target) || path.basename(target);
}

/** Diagrams default to .excalidraw so the file opens in the usual editors. */
export function resolveBoardPath(candidate: string): string {
  const resolved = resolveInWorkspace(candidate);
  return path.extname(resolved) ? resolved : `${resolved}.excalidraw`;
}

/**
 * Where a *new* board may be written: inside the project's diagram directory.
 *
 * Only authoring is confined this way. Reading, serving, editing and checking a
 * board named by hand still work anywhere in the workspace, so nothing that
 * already exists somewhere else breaks — and no migration is forced by this.
 *
 * The restriction is what makes discovery trustworthy. `check_drift` and the
 * board CLI find boards by looking in one directory; a diagram written outside
 * it is invisible to both, and they report clean rather than admitting they
 * never saw it. Refusing here means that board cannot come into being, so there
 * is nothing to be blind to.
 */
export function resolveNewBoardPath(candidate: string): string {
  const resolved = resolveBoardPath(candidate);
  const directory = diagramDir(WORKSPACE_ROOT);
  const allowed = path.resolve(WORKSPACE_ROOT, directory);
  const relative = path.relative(allowed, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Diagrams live in ${directory}/ — write this one to ${path.join(directory, path.basename(resolved))} `
      + `instead of ${relativeToWorkspace(resolved)}. `
      + `A board outside that directory is invisible to check_drift and to the board CLI, both of which `
      + `discover diagrams by looking there. To keep this project's diagrams somewhere else, set `
      + `{"diagrams": "..."} in ${CONFIG_FILE}.`,
    );
  }
  return resolved;
}
