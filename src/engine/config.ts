/**
 * Where a project keeps its diagrams.
 *
 * One question with one answer, asked by everything: `create_diagram` when
 * deciding whether a path is allowed, `check_drift` and the board CLI when
 * discovering boards with no path given. Before this, `docs/diagrams` was
 * hardcoded in the engine and merely suggested to the model, so the three could
 * disagree — and a board written one directory off was invisible to the checks
 * without either side noticing.
 *
 * Deliberately a committed file rather than an environment variable. A port is a
 * property of the machine, which is why DIAGRAMOS_PORT is an env var; a diagram
 * directory is a property of the repository, and an env var would let two people
 * on the same project, and CI, hold different beliefs about it. It also cannot
 * be persisted by an agent: a variable set inside one tool call dies with that
 * process, while a file it writes once is read by everything afterwards.
 *
 * Not `.diagramos/`, which is in .gitignore and holds local per-user state.
 * Not package.json, because this tool is language-agnostic on purpose.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** Committed, at the repository root. Absent in almost every project. */
export const CONFIG_FILE = ".diagramos.json";

/** Where diagrams live unless the project says otherwise. */
export const DEFAULT_DIAGRAM_DIR = "docs/diagrams";

export interface ProjectConfig {
  /** Repo-relative directory holding this project's boards. */
  diagrams: string;
}

/** Thrown for a config that exists but cannot be honoured. */
export class ConfigError extends Error {}

/**
 * Rejects anything that would send board discovery outside the repository, or
 * somewhere a repo-relative path cannot describe.
 *
 * A bad value is an error rather than a fallback to the default. Quietly looking
 * somewhere other than where the project said is the exact failure this file
 * exists to remove; doing it again as error handling would be worse, because
 * nothing would be on screen to explain the silence.
 */
function validate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`${CONFIG_FILE}: "diagrams" must be a non-empty string`);
  }
  const candidate = value.trim();
  if (path.isAbsolute(candidate)) {
    throw new ConfigError(`${CONFIG_FILE}: "diagrams" must be relative to the project, got ${candidate}`);
  }
  // One directory, one spelling. path.normalize keeps a trailing separator, so
  // "docs/diagrams" and "docs/diagrams/" would otherwise be different strings
  // naming the same place -- and they are compared as strings when a message
  // says where diagrams belong.
  const normalised = path.normalize(candidate).replace(/[\\/]+$/, "") || ".";
  if (normalised === ".." || normalised.startsWith(`..${path.sep}`)) {
    throw new ConfigError(`${CONFIG_FILE}: "diagrams" must stay inside the project, got ${candidate}`);
  }
  return normalised;
}

/**
 * This project's config, or the defaults when there is no config file.
 *
 * A missing file is the ordinary case and means the defaults. A file that is
 * present but broken throws: someone wrote it on purpose and is entitled to
 * find out it is not being honoured.
 */
export function readProjectConfig(root: string): ProjectConfig {
  let raw: string;
  try {
    raw = readFileSync(path.join(root, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { diagrams: DEFAULT_DIAGRAM_DIR };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object`);
  }
  const { diagrams } = parsed as { diagrams?: unknown };
  return { diagrams: diagrams === undefined ? DEFAULT_DIAGRAM_DIR : validate(diagrams) };
}

/** Repo-relative directory this project keeps its boards in. */
export function diagramDir(root: string): string {
  return readProjectConfig(root).diagrams;
}
