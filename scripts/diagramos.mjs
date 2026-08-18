#!/usr/bin/env node
/**
 * The published entry point: `diagramos`.
 *
 *   diagramos                  # speak MCP over stdio -- what the plugin runs
 *   diagramos board            # the live board
 *   diagramos drift            # the drift check
 *   diagramos stop             # stop board servers
 *
 * Bare `diagramos` has to stay the MCP server. `.claude-plugin/plugin.json`
 * runs `npx -y diagramos@<version>` with no arguments and then talks protocol
 * down stdin; a usage message there would look to the client like a server that
 * failed to handshake, with nothing readable to say why.
 *
 * Each subcommand stays a separate built file rather than a branch inside one
 * bundle, so starting the MCP server does not parse the board server, the drift
 * check and the stop command on the way past. That is also why the import below goes through a
 * URL: it is a sibling output resolved at runtime, not a module to inline.
 */

/** Subcommand -> the file built beside this one. */
const COMMANDS = { board: "board.mjs", drift: "drift.mjs", stop: "stop.mjs" };

const USAGE = [
  "usage: diagramos [command]",
  "",
  "  diagramos              speak MCP over stdio (what the Claude Code plugin runs)",
  "  diagramos board        serve boards in a live local page",
  "  diagramos drift        report diagrams that no longer match the code",
  "  diagramos stop         stop board servers (--list to see them first)",
  "",
  "Every command takes --help of their own.",
].join("\n");

const [first] = process.argv.slice(2);

if (first === "--help" || first === "-h" || first === "help") {
  console.log(USAGE);
  process.exit(0);
}

/*
 * A bare invocation is the MCP server; a named one has to be a command we know.
 * Without this a typo would start the MCP server instead, which reads stdin and
 * says nothing -- indistinguishable from a hang.
 */
if (first !== undefined && !(first in COMMANDS) && !first.startsWith("-")) {
  console.error(`diagramos: unknown command "${first}"`);
  console.error(USAGE);
  process.exit(2);
}

const entry = COMMANDS[first];
if (entry) {
  // Hand the subcommand its own argv: it reads process.argv.slice(2) the way it
  // did as a bin of its own, and must not find its own name at the front.
  process.argv.splice(2, 1);
}

await import(new URL(`./${entry ?? "server.mjs"}`, import.meta.url).href);
