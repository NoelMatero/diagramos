/**
 * The corpus projects' own libraries, installed beside the pinned clones
 * rather than in them (#429).
 *
 * A user's checkout has its libraries: a Flask developer has blinker in a
 * venv, a TanStack one has run `pnpm install`. The bench machine had neither,
 * so pyright could not say what `request_started.send(...)` is and the
 * TypeScript compiler could not type anything React returns, and those arrows
 * stopped where a user's would not. `scripts/bench-libraries.mts` installs
 * them, at the versions pinned in `bench/libraries/`, into one folder:
 *
 *   <libraries>/python/<project>/      a venv per Python project, never
 *                                      holding the project itself
 *   <libraries>/corpus/<project>/      a checkout of a TypeScript project at
 *                                      its pin, with its packages installed
 *   <libraries>/installed.json         what was installed, from which pins
 *
 * Nothing is written into `.corpus`, which every session's bench reads.
 *
 * Every script that starts a language server on a corpus project asks
 * `useLibraries` for the root first. Pyright finds the interpreter on `PATH`,
 * the same way it would in a user's activated venv, so the venv goes first on
 * `PATH` for that project and comes off it for the next.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { BENCH_DIR, CORPUS, HOLDOUT, type HoldoutProject } from "./bench-set";

export { CORPUS };
export const LIBRARIES = process.env.BENCH_LIBRARIES ?? path.join(path.dirname(CORPUS), ".corpus-libs");

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
/** The holdout's projects, with their pins and install commands; empty for the main set. */
export const HOLDOUT_PROJECTS: HoldoutProject[] = HOLDOUT
  ? JSON.parse(readFileSync(path.join(REPO, BENCH_DIR, "projects.json"), "utf8")) as HoldoutProject[]
  : [];

/** The projects whose libraries are installed, by how. The rest need none, or have them in `.corpus` already. */
export const PYTHON_PROJECTS = HOLDOUT
  ? HOLDOUT_PROJECTS.filter((one) => one.language === "python").map((one) => one.project)
  : ["django-django", "encode-httpx", "pallets-flask", "pydantic-pydantic", "python-poetry-poetry"];
export const NODE_PROJECTS = HOLDOUT
  ? HOLDOUT_PROJECTS.filter((one) => one.install).map((one) => one.project)
  : ["TanStack-query"];

export interface Installed { pins: string; python: string; projects: string[] }

export function installed(): Installed | undefined {
  try {
    return JSON.parse(readFileSync(path.join(LIBRARIES, "installed.json"), "utf8")) as Installed;
  } catch {
    return undefined;
  }
}

const venvBin = (project: string) => path.join(LIBRARIES, "python", project, "bin");
let added: string | undefined;

/**
 * The root to read `project` at, with its libraries in reach: its own
 * checkout when one was installed, and its venv first on `PATH` for every
 * language server started from here on. Falls back to `.corpus` as it is.
 */
export function useLibraries(project: string): string {
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter((one) => one !== added);
  added = undefined;
  const bin = venvBin(project);
  if (PYTHON_PROJECTS.includes(project) && existsSync(path.join(bin, "python"))) {
    added = bin;
    parts.unshift(bin);
  }
  process.env.PATH = parts.join(path.delimiter);
  const own = path.join(LIBRARIES, "corpus", project);
  return NODE_PROJECTS.includes(project) && existsSync(path.join(own, "node_modules")) ? own : path.join(CORPUS, project);
}

/** One line for a run's header, so a score says which machine it was taken on. */
export function librariesLine(): string {
  const found = installed();
  if (!found) {
    return `libraries: not installed (${LIBRARIES}); Python and TanStack arrows read as on a bare clone`
      + " -- npm run bench:libraries";
  }
  return `libraries: installed from pins ${found.pins} (${found.projects.length} projects, ${LIBRARIES})`;
}
