#!/usr/bin/env node
/**
 * Installs the corpus projects' own libraries for the bench (#429).
 *
 *   npm run bench:libraries            # install what is missing or out of date
 *   npm run bench:libraries -- --force # reinstall everything
 *
 * Each Python project gets a venv holding its dependencies at the versions in
 * `bench/libraries/<project>.txt` (never the project itself: pyright reads the
 * project from its clone). TanStack gets a checkout of its pin with
 * `pnpm install --frozen-lockfile` run in it, at the pnpm its `package.json`
 * names. Everything goes into the folder `bench-libraries.ts` names, beside
 * `.corpus` and never in it.
 *
 * Needs `uv` and `git` on `PATH`, and the network.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CORPUS, LIBRARIES, NODE_PROJECTS, PYTHON_PROJECTS, installed, type Installed } from "./lib/bench-libraries";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PINS = path.join(REPO, "bench/libraries");
/** One interpreter for all five: django needs 3.12 or newer, and pyright reads the standard library of this one. */
const PYTHON = "3.14";
/**
 * The workspace packages the TanStack boards point into, and what they depend
 * on: every ref is in `query-core` or `react-query`. The whole workspace is
 * every framework's examples too, for nothing the bench reads.
 */
const NODE_FILTER: Record<string, string> = { "TanStack-query": "@tanstack/react-query..." };

const force = process.argv.includes("--force");
const run = (command: string, args: string[], cwd?: string) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

/** The commit each project's answer keys describe. */
function pinOf(project: string): string {
  const dir = path.join(REPO, "bench/boards", project);
  const key = readdirSync(dir).find((file) => file.endsWith(".answers.json"));
  if (!key) throw new Error(`no answer key for ${project}`);
  return (JSON.parse(readFileSync(path.join(dir, key), "utf8")) as { pin: string }).pin;
}

/** One hash over every pin file and every TypeScript project's commit: what `installed.json` is compared by. */
function pinsHash(): string {
  const hash = createHash("sha1");
  for (const project of PYTHON_PROJECTS) hash.update(readFileSync(path.join(PINS, `${project}.txt`)));
  for (const project of NODE_PROJECTS) hash.update(`${project}@${pinOf(project)}`);
  hash.update(PYTHON);
  return hash.digest("hex").slice(0, 10);
}

const pins = pinsHash();
const was = installed();
if (!force && was?.pins === pins) {
  console.log(`Already installed from pins ${pins} in ${LIBRARIES}. --force reinstalls.`);
  process.exit(0);
}
rmSync(path.join(LIBRARIES, "installed.json"), { force: true });

for (const project of PYTHON_PROJECTS) {
  const venv = path.join(LIBRARIES, "python", project);
  console.log(`\n${project}: venv at ${venv}`);
  run("uv", ["venv", "--quiet", "--clear", "--python", PYTHON, venv]);
  run("uv", ["pip", "install", "--quiet", "--python", path.join(venv, "bin/python"), "--no-deps",
    "-r", path.join(PINS, `${project}.txt`)]);
}

for (const project of NODE_PROJECTS) {
  const pin = pinOf(project);
  const own = path.join(LIBRARIES, "corpus", project);
  console.log(`\n${project}: checkout of ${pin} at ${own}`);
  rmSync(own, { recursive: true, force: true });
  mkdirSync(path.dirname(own), { recursive: true });
  run("git", ["clone", "--quiet", "--no-checkout", path.join(CORPUS, project), own]);
  run("git", ["checkout", "--quiet", pin], own);
  const manager = (JSON.parse(readFileSync(path.join(own, "package.json"), "utf8")) as { packageManager?: string })
    .packageManager;
  if (!manager?.startsWith("pnpm@")) throw new Error(`${project} names no pnpm version in package.json`);
  run("npx", ["--yes", manager, "install", "--frozen-lockfile", "--ignore-scripts",
    ...(NODE_FILTER[project] ? ["--filter", NODE_FILTER[project]!] : [])], own);
  if (!existsSync(path.join(own, "node_modules"))) throw new Error(`${project}: pnpm left no node_modules`);
}

const python = execFileSync(path.join(LIBRARIES, "python", PYTHON_PROJECTS[0]!, "bin/python"), ["--version"],
  { encoding: "utf8" }).trim();
const record: Installed = { pins, python, projects: [...PYTHON_PROJECTS, ...NODE_PROJECTS] };
writeFileSync(path.join(LIBRARIES, "installed.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(`\nInstalled from pins ${pins} (${python}) in ${LIBRARIES}.`);
