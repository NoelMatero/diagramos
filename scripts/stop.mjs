#!/usr/bin/env node
/**
 * Sees and stops board servers.
 *
 *   diagramos stop           # stop every board server running on this machine
 *   diagramos stop --list    # show them, stop nothing
 *
 * This exists because a board server has no fixed address. It takes 4747 when
 * that is free and an ephemeral port when it is not, so there was no way to find
 * one without `lsof`, and no way to stop one without reading a pid out of it.
 * Nine were once found running here, on eight ports, the oldest five days old.
 *
 * Machine-wide rather than per-project on purpose: the pile that made this
 * necessary spanned projects, and a stop command that leaves some of it behind
 * would send you back to `lsof` for the rest. What each one serves is printed
 * before it is stopped, so nothing goes quietly.
 */
import { listServers, stopServer } from "../src/server/server-registry.ts";

const USAGE = [
  "usage: diagramos stop [--list]",
  "",
  "  no arguments   stop every board server running on this machine",
  "  --list         show what is running, stop nothing",
  "",
  "A board is a file in your repository. Stopping its server closes the live",
  "page, and changes nothing on disk.",
].join("\n");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const listOnly = args.includes("--list");
const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--list");
if (unknown) {
  console.error(`diagramos stop: unknown option ${unknown}`);
  console.error(USAGE);
  process.exit(2);
}
const stray = args.find((arg) => !arg.startsWith("-"));
if (stray) {
  console.error(`diagramos stop: unexpected argument "${stray}"`);
  console.error(USAGE);
  process.exit(2);
}

/** "3 days" / "20 minutes" — age is what marks a server nobody meant to keep. */
const age = (startedAt) => {
  const started = Date.parse(startedAt ?? "");
  if (Number.isNaN(started)) return "unknown age";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  const [amount, unit] =
    seconds < 90
      ? [seconds, "second"]
      : seconds < 5400
        ? [Math.round(seconds / 60), "minute"]
        : seconds < 172_800
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86_400), "day"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
};

/** The project a server serves, shortened to something a person recognises. */
const where = (entry) => {
  if (!entry.root) return "no project";
  const home = process.env.HOME;
  return home && entry.root.startsWith(home) ? `~${entry.root.slice(home.length)}` : entry.root;
};

const describe = (entry) =>
  [
    `pid ${String(entry.pid).padEnd(7)}`,
    `port ${String(entry.port).padEnd(6)}`,
    `up ${age(entry.startedAt).padEnd(11)}`,
    where(entry),
    entry.owner ? `(owned by pid ${entry.owner})` : "",
  ]
    .filter(Boolean)
    .join(" ");

const { running, pruned } = await listServers();

// Said out loud rather than swallowed: a pruned entry means a server was killed
// without getting to tidy up, and seeing that is how you learn the difference
// between "none running" and "nothing was ever recorded".
if (pruned > 0) {
  console.log(`swept ${pruned} stale ${pruned === 1 ? "entry" : "entries"} for servers that are gone`);
}

if (running.length === 0) {
  console.log("no board servers running");
  process.exit(0);
}

if (listOnly) {
  console.log(`${running.length} board ${running.length === 1 ? "server" : "servers"} running`);
  for (const entry of running) console.log(`  ${describe(entry)}`);
  console.log("");
  console.log("diagramos stop  stops all of them");
  process.exit(0);
}

let stopped = 0;
let failed = 0;
for (const entry of running) {
  const { how } = await stopServer(entry);
  if (how === "refused") {
    failed += 1;
    console.error(`could not stop pid ${entry.pid} (${where(entry)}) — it is not ours to signal`);
    continue;
  }
  if (how === "gone") {
    console.log(`already gone   ${describe(entry)}`);
    continue;
  }
  stopped += 1;
  console.log(`stopped        ${describe(entry)}${how === "killed" ? " (had to force it)" : ""}`);
}

console.log("");
console.log(
  stopped === 0
    ? "nothing left to stop"
    : `stopped ${stopped} board ${stopped === 1 ? "server" : "servers"}. Your diagrams are untouched — run diagramos board to look again.`,
);

// A server that refused to die is the one case where a caller scripting this
// needs to know, so it is the only thing that fails the command.
process.exit(failed > 0 ? 1 : 0);
