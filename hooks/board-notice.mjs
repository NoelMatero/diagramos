/**
 * The one line board-notice.sh prints, when a board server is running (#285).
 *
 *   board running for orangutan on :4747 · 0.2.0-rc.6 · up 3h · stop: npx diagramos stop
 *
 * Plain node and nothing else: a plugin is copied into a cache without an npm
 * install, so this file cannot import the package it describes. It reads the
 * same registry `src/server/server-registry.ts` writes, and only reads it --
 * a dead entry is skipped, never swept, because this hook changes nothing.
 *
 * Every server is counted, not only this project's: the forgotten one is
 * usually somewhere else. And the two cases that produce wrong answers are
 * named -- an older build, and a build from a local checkout.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [installed = "", project = process.cwd()] = process.argv.slice(2);
const override = process.env.DIAGRAMOS_STATE_DIR?.trim();
const registry = override ? path.resolve(override) : path.join(os.homedir(), ".diagramos", "servers");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function real(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** `0.1.9` < `0.2.0-rc.6` < `0.2.0`. Enough of semver for the versions this package has shipped. */
function compareVersions(a, b) {
  const split = (version) => {
    const [core, pre] = String(version).split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] || 0) - (right.core[i] || 0);
    if (diff) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

function uptime(startedAt) {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `up ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `up ${hours}h` : `up ${Math.floor(hours / 24)}d`;
}

const home = os.homedir();
const tilde = (target) =>
  target === home || target.startsWith(home + path.sep) ? `~${target.slice(home.length)}` : target;

const servers = [];
for (const name of readdirSync(registry)) {
  if (!name.endsWith(".json")) continue;
  try {
    const entry = JSON.parse(readFileSync(path.join(registry, name), "utf8"));
    if (typeof entry.pid === "number" && typeof entry.port === "number" && alive(entry.pid)) {
      servers.push(entry);
    }
  } catch {
    // Unreadable is not ours to fix here; `diagramos stop --list` sweeps it.
  }
}
if (servers.length === 0) process.exit(0);

const here = real(project);
const rootsOf = (entry) => (Array.isArray(entry.roots) && entry.roots.length ? entry.roots : entry.root ? [entry.root] : []);
const servesHere = (entry) => rootsOf(entry).some((root) => real(root) === here);
servers.sort((a, b) =>
  Number(servesHere(b)) - Number(servesHere(a)) || String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));

const first = servers[0];
const named = servesHere(first) ? path.basename(here) : path.basename(rootsOf(first)[0] ?? "") || "another project";
const version = typeof first.build?.version === "string" ? first.build.version : undefined;
const parts = [`board running for ${named} on :${first.port}`];

if (version) parts.push(version);
const up = uptime(first.startedAt);
if (up) parts.push(up);
if (!version) {
  parts.push(`unknown version, older than the installed ${installed}`);
} else if (installed && compareVersions(version, installed) < 0) {
  parts.push(`older than the installed ${installed}`);
} else if (installed && compareVersions(version, installed) > 0) {
  parts.push(`newer than the installed ${installed}`);
}

// An installed build lives under node_modules (npx's cache included); anything
// else is somebody's checkout, whose code changes under a running server.
const builtFrom = Array.isArray(first.build?.builtFrom) ? first.build.builtFrom.filter((dir) => typeof dir === "string") : [];
const checkout = builtFrom.find((dir) => !dir.split(path.sep).includes("node_modules"));
if (checkout) parts.push(`from ${tilde(checkout.replace(/[/\\](out[/\\]cli|src|scripts)[/\\]?$/, ""))}`);

parts.push("stop: npx diagramos stop");
const others = servers.length - 1;
if (others) parts.push(`and ${others} ${others === 1 ? "other" : "others"} (npx diagramos stop --list)`);

process.stdout.write(`${JSON.stringify({ systemMessage: parts.join(" · ") })}\n`);
