#!/usr/bin/env node
/**
 * Serves boards live, without going through the MCP server.
 *
 *   diagramos board                                  # every board in docs/diagrams
 *   diagramos board docs/diagrams/example.excalidraw # the ones you name
 *
 * Inside this repo the same command is `npm run board`.
 *
 * This is the only way to look at a board without an MCP client running, which
 * is what makes the diagrams readable offline: the viewer it serves is the one
 * in the tarball, fonts included, and it needs no network.
 *
 * The page follows the file: anything that writes it -- Claude, another
 * editor, git checkout -- shows up immediately, and anything drawn in the page
 * is written straight back.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { readBoard, writeBoard } from "../src/engine/board-file.ts";
import { CONFIG_FILE, ConfigError, DEFAULT_DIAGRAM_DIR, diagramDir } from "../src/engine/config.ts";
import { findBoards, findStrayBoards } from "../src/engine/drift.ts";
import { fileExists, probeBoard, resolveBoardPort, startBoardServer } from "../src/server/board-server.ts";

const root = process.cwd();

/** Ends the command with a sentence. A stack trace here is a bug report about us, not help. */
const fail = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(2);
};

/** A board named on the command line: the `.excalidraw` extension is implied. */
const named = (target) => path.resolve(root, path.extname(target) ? target : `${target}.excalidraw`);

// Named boards, or every board in the standard directory. Discovery goes
// through the same findBoards the drift check uses, so both commands mean the
// same thing by "the boards in this project" and there is one convention to
// learn rather than two.
const args = process.argv.slice(2);

const USAGE = [
  "usage: diagramos board [board.excalidraw ...]",
  "",
  "  no arguments   serve every board in this project's diagram directory",
  `                 (${DEFAULT_DIAGRAM_DIR}, or "diagrams" in ${CONFIG_FILE})`,
  "  a board path   serve the ones you name, creating any that is not there yet",
  "",
  "  DIAGRAMOS_PORT       port to serve on (default 4747)",
  "  DIAGRAMOS_NO_OPEN=1  do not launch a browser",
].join("\n");

if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// A flag is not a filename. Without this, `--help` becomes `--help.excalidraw`
// and the command answers by creating it.
const unknownOption = args.find((arg) => arg.startsWith("-"));
if (unknownOption) fail(`unknown option ${unknownOption}`, USAGE);

// A broken config is fatal rather than a quiet fall back to the default: serving
// diagrams from somewhere the project did not name is worse than not starting.
let directory;
try {
  directory = diagramDir(root);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  fail(error.message);
}

const boards = args.length ? args.map(named) : await findBoards(root, directory);

if (!boards.length) {
  // Nothing here is the moment to spend a read of the whole repository finding
  // out whether the boards are simply somewhere else.
  const strays = await findStrayBoards(root, directory);
  fail(
    `no boards in ${directory}/`,
    ...(strays.boards.length
      ? [
          `found ${strays.boards.length + strays.more} elsewhere: ${strays.boards.join(", ")}`,
          `name one directly, move them into ${directory}/, or set {"diagrams": "..."} in ${CONFIG_FILE}`,
        ]
      : [USAGE]),
  );
}

// Every board has to sit inside the directory the server is rooted at. That
// root is what stops `?file=` and the takeover endpoint from reaching an
// arbitrary file on disk, so a board outside it is refused rather than served
// by widening the root to cover it.
for (const board of boards) {
  const relative = path.relative(root, board);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`board is outside ${root}: ${board}`, "run diagramos board from the project the board lives in");
  }
}

// Materialise a board that is not there yet, so the watcher has something to
// follow -- naming a new file is how you start one. Boards that already exist
// are left untouched: rewriting them here would put a diff in someone's
// working tree just for looking at them.
for (const board of boards) {
  if (!(await fileExists(board))) await writeBoard(board, await readBoard(board));
}

const openBrowser = (url) => {
  if (process.env.DIAGRAMOS_NO_OPEN === "1") return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
};

/**
 * A pinned URL for a board on a server we do not own.
 *
 * By absolute path deliberately: a relative name resolves against *that*
 * server's root, and two projects both holding docs/diagrams/architecture
 * would quietly hand back the wrong one. Slashes are left unescaped -- a query
 * value does not need them escaped, and this URL is the thing being read.
 */
const pinnedOn = (port, board) =>
  `http://127.0.0.1:${port}/?file=${encodeURIComponent(board).replace(/%2F/g, "/")}`;

/**
 * Whether the server already on this port will serve *these* boards.
 *
 * The port is shared across every project on the machine, so what answers is
 * often a board server belonging to another repo. Health does not report its
 * root, and asking is the only way to find out: a board outside that root comes
 * back 403, and starting a second server is then the right move rather than a
 * failure.
 */
async function sharesTheseBoards(port, board) {
  const probe = await probeBoard(port);
  if (!probe?.multiBoard) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/board?file=${encodeURIComponent(board)}`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok ? probe : undefined;
  } catch {
    return undefined;
  }
}

/** A port nobody is on, for when the usual one is taken. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

let wanted;
try {
  wanted = resolveBoardPort(process.env.DIAGRAMOS_PORT);
} catch (error) {
  fail(error.message);
}

// Already live and already serving this project -- usually a board Claude
// opened in a session that is still running. A second server would be a second
// set of URLs for the same files, so hand over the ones that work and stop.
const shared = await sharesTheseBoards(wanted, boards[0]);
if (shared) {
  console.log(`board server already running on ${wanted} (pid ${shared.pid})`);
  for (const board of boards) {
    console.log(`board  ${path.relative(root, board)}`);
    console.log(`live   ${pinnedOn(wanted, board)}`);
  }
  openBrowser(pinnedOn(wanted, boards[0]));
  process.exit(0);
}

let port = wanted;
let server;
try {
  server = await startBoardServer({ file: boards[0], port, root });
} catch (error) {
  if (error?.code !== "EADDRINUSE") throw error;
  // Something else holds the usual port: another project's board, or a program
  // with nothing to do with us. Moving to a free one beats refusing to start,
  // and saying whose it is beats leaving someone to hunt for the process.
  const occupant = await probeBoard(wanted);
  port = await freePort();
  server = await startBoardServer({ file: boards[0], port, root });
  console.log(
    occupant?.file
      ? `port ${wanted} is serving ${path.dirname(occupant.file)} (pid ${occupant.pid}) — using ${port} instead`
      : `port ${wanted} is in use by something else — using ${port} instead`,
  );
}

/*
 * One board gets the bare URL, which follows whatever is written next -- what
 * you want when you are working on one diagram and letting Claude drive.
 * Several get pinned URLs, so boards opened side by side each stay on their own
 * file no matter what gets written.
 */
const urlFor = (board) => (boards.length === 1 ? server.url : server.urlFor(board));

for (const board of boards) {
  console.log(`board  ${path.relative(root, board)}`);
  console.log(`live   ${urlFor(board)}`);
}
console.log("ctrl-c to stop");

openBrowser(urlFor(boards[0]));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
