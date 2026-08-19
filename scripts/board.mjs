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
 *
 * The command does not stay in the foreground. It makes sure a background board
 * service is running, prints where the boards are, and gives you back your
 * prompt -- so closing the terminal, or the session that opened it, leaves the
 * boards up. `diagramos stop` is what ends them.
 */
import path from "node:path";
import { spawn } from "node:child_process";

import { readBoard, writeBoard } from "../src/engine/board-file.ts";
import { CONFIG_FILE, ConfigError, DEFAULT_DIAGRAM_DIR, diagramDir } from "../src/engine/config.ts";
import { findBoards, findStrayBoards } from "../src/engine/drift.ts";
import { fileExists, resolveBoardPort } from "../src/server/board-server.ts";
import { ensureBoardServer } from "../src/server/daemon.ts";

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
  "",
  "Boards are served by a background service that outlives this terminal.",
  "",
  "  diagramos stop --list  what is already running",
  "  diagramos stop         stop it, from any terminal",
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
 * A pinned URL for a board on the service.
 *
 * By name rather than absolute path: the service resolves a relative name
 * against the root it serves, which is this project. Slashes are left unescaped
 * -- a query value does not need them escaped, and this URL is the thing being
 * read.
 */
const pinnedOn = (port, board) =>
  `http://127.0.0.1:${port}/?file=${encodeURIComponent(path.relative(root, board)).replace(/%2F/g, "/")}`;

let wanted;
try {
  wanted = resolveBoardPort(process.env.DIAGRAMOS_PORT);
} catch (error) {
  fail(error.message);
}

/*
 * Ask for a service rather than becoming one.
 *
 * This used to hold the server in the foreground, which meant the boards went
 * away with the terminal -- and a run that was not interactive left a server
 * behind that nobody could see. Both problems were the same problem: the server
 * belonged to whatever happened to start it. Now it belongs to the person, and
 * ending it is something you ask for.
 */
/*
 * No owner. The service belongs to the person, not to this terminal.
 *
 * The previous rule -- adopt the parent unless a person is watching -- existed
 * to stop board servers accumulating, and it is not what stops them now. A
 * project gets one service and every later run of this command finds it, so
 * there is nothing left to accumulate. What is left is a service nobody comes
 * back to, and that is handled by the service itself: it shuts down after long
 * enough with nothing looking at it.
 */
let service;
try {
  service = await ensureBoardServer({ root, port: wanted, file: boards[0], startedBy: "diagramos board" });
} catch (error) {
  fail(error.message);
}

if (service.port !== wanted) {
  // Worth saying: someone looking for 4747 needs to know why it is not there.
  console.log(`port ${wanted} was taken — this project is on ${service.port}`);
}

for (const board of boards) {
  console.log(`board  ${path.relative(root, board)}`);
  console.log(`live   ${pinnedOn(service.port, board)}`);
}
console.log(`all    http://127.0.0.1:${service.port}/boards`);
console.log("");
console.log(
  service.started
    ? `started a board service (pid ${service.pid}). It keeps running after this terminal closes.`
    : `using the board service already running (pid ${service.pid}).`,
);
console.log("diagramos stop        stop it, from any terminal");

openBrowser(pinnedOn(service.port, boards[0]));
