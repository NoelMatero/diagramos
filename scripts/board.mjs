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
import { CONFIG_FILE, ConfigError, DEFAULT_DIAGRAM_DIR, diagramDir, projectRootFor } from "../src/engine/config.ts";
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
  "  a board path   serve the ones you name, creating any that is not there yet.",
  "                 They may live in another project; it joins the same service",
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

/*
 * A board named here can live in another project.
 *
 * It could not before, because a service was confined to one directory and
 * serving a board outside it would have meant removing the guard that stops a
 * page reaching an arbitrary file. A service now holds a set of projects, so
 * the board's own project is added to it instead -- the guard stays, and the
 * set of places it allows is the set you actually named.
 *
 * The extension is checked here rather than left to the server, so naming the
 * wrong file fails with a sentence instead of a 403 from a URL.
 */
for (const board of boards) {
  if (path.extname(board).toLowerCase() !== ".excalidraw") {
    fail(`not a board: ${board}`, "a board is a .excalidraw file");
  }
}

/*
 * The projects to serve, this one first when it is among them: a relative board
 * name resolves against the project the service started in, so putting the
 * directory you are standing in anywhere else would make the short URLs mean
 * somebody else's boards.
 */
/*
 * A board here belongs to here. Only a board somewhere else has to have its
 * project worked out, and the answer for one outside any repository is its own
 * directory -- narrower than the truth, never wider. Asking `projectRootFor`
 * about a board in this project would answer with whatever marker it found
 * first, which for a project with no `.git` is `docs/diagrams`, and a service
 * rooted there would make every relative name and every ref resolve one
 * directory too deep.
 */
const projectOf = (board) => {
  const relative = path.relative(root, board);
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? root : projectRootFor(board);
};

const projects = [...new Set(boards.map((board) => projectOf(board)))];
const ordered = projects.includes(root) ? [root, ...projects.filter((project) => project !== root)] : projects;

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
 * How the service will understand a board's name.
 *
 * Relative for boards inside the project the service started in, absolute for
 * everything else. Which project that is belongs to the *service*, not to us --
 * it may have been running for days, started somewhere entirely different -- so
 * it is read back from the service rather than assumed to be this directory.
 * Assuming would produce a short URL that quietly resolves to another
 * repository's board of the same name.
 */
const nameOn = (probe, board) => {
  const base = probe?.root;
  if (!base) return board;
  const relative = path.relative(base, board);
  return relative.startsWith("..") || path.isAbsolute(relative) ? board : relative;
};

/**
 * A pinned URL for a board on the service. Slashes are left unescaped -- a query
 * value does not need them escaped, and this URL is the thing being read.
 */
const pinnedOn = (port, probe, board) =>
  `http://127.0.0.1:${port}/?file=${encodeURIComponent(nameOn(probe, board)).replace(/%2F/g, "/")}`;

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
  /*
   * One call per project, and the same call whether one is running or not:
   * asking for a service that exists adds the project to it, so serving boards
   * from three repositories is three asks rather than three services.
   */
  for (const project of ordered) {
    const first = boards.find((board) => projectOf(board) === project);
    const next = await ensureBoardServer({
      root: project,
      port: wanted,
      file: first,
      startedBy: "diagramos board",
    });
    // `started` is true if any of them had to start one; the rest joined it.
    service = { ...next, started: Boolean(service?.started) || next.started };
  }
} catch (error) {
  fail(error.message);
}

if (service.port !== wanted) {
  // Worth saying: someone looking for 4747 needs to know why it is not there.
  console.log(`port ${wanted} was taken — this project is on ${service.port}`);
}

for (const board of boards) {
  // Shown relative to where you are standing, which is what you typed, even
  // when the URL has to name it absolutely for the service.
  const shown = path.relative(root, board);
  console.log(`board  ${shown.startsWith("..") ? board : shown}`);
  console.log(`live   ${pinnedOn(service.port, service.probe, board)}`);
}
console.log(`all    http://127.0.0.1:${service.port}/boards`);
console.log("");
console.log(
  service.started
    ? `started a board service (pid ${service.pid}). It keeps running after this terminal closes.`
    : `using the board service already running (pid ${service.pid}).`,
);
console.log("diagramos stop        stop it, from any terminal");

openBrowser(pinnedOn(service.port, service.probe, boards[0]));
