#!/usr/bin/env node
/**
 * The background board service.
 *
 *   diagramos serve    # normally started for you, not typed
 *
 * This is the process that actually serves boards. It is spawned detached by
 * whatever needed a board first -- `diagramos board`, or a Claude session
 * calling open_board -- and then belongs to nobody: closing that terminal or
 * quitting that session leaves it running, which is the point. `diagramos stop`
 * ends it.
 *
 * It normally has no owner: a service that shut down with its starter would put
 * us back where we began, with a board that disappears when the window that
 * opened it closes. A caller nobody is watching -- a script, a CI step -- can
 * still name one through DIAGRAMOS_OWNER_PID, so an unattended run cleans up
 * after itself rather than leaving a service nobody will ever look at.
 *
 * Its output goes to a log in the state directory, because a detached process
 * has no terminal to print to and a silent failure to start is the hardest kind
 * to diagnose.
 */
import path from "node:path";
import { createServer } from "node:net";

import { diagramDir } from "../src/engine/config.ts";
import { findBoards } from "../src/engine/drift.ts";
import { fileExists, resolveBoardPort, startBoardServer } from "../src/server/board-server.ts";

const root = process.cwd();

const say = (...parts) => console.log(`[${new Date().toISOString()}] ${parts.join(" ")}`);

/** A port nobody is on, for when the usual one is taken by another project. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/*
 * The board to open on. Given by whoever asked for the service, and otherwise
 * the first board in the project -- the same set `diagramos board` serves, so
 * both mean the same thing by "the boards here".
 */
let file = process.env.DIAGRAMOS_BOARD;
if (!file || !(await fileExists(file))) {
  const boards = await findBoards(root, diagramDir(root)).catch(() => []);
  file = boards[0];
}
if (!file) {
  say(`no boards found in ${root} — nothing to serve`);
  process.exit(1);
}

let port;
try {
  port = resolveBoardPort(process.env.DIAGRAMOS_PORT);
} catch (error) {
  say(error.message);
  process.exit(2);
}

const startedBy = process.env.DIAGRAMOS_STARTED_BY ?? "diagramos serve";
const ownerPid = Number.parseInt(process.env.DIAGRAMOS_OWNER_PID ?? "", 10);
const options = {
  file,
  root,
  startedBy,
  ...(Number.isInteger(ownerPid) && ownerPid > 1 ? { ownerPid } : {}),
};

let server;
try {
  server = await startBoardServer({ ...options, port });
} catch (error) {
  if (error?.code !== "EADDRINUSE") throw error;
  // The usual port belongs to another project's service. Moving to a free one
  // beats refusing to start; the registry is what makes an ephemeral port
  // findable again, so nothing is lost by not being on 4747.
  port = await freePort();
  server = await startBoardServer({ ...options, port });
}

say(
  `serving ${root} on ${server.port} (pid ${process.pid}) — started by ${startedBy}`
    + (options.ownerPid ? `, owned by pid ${options.ownerPid}` : ""),
);

// The service can end without being signalled -- the idle fuse closes it and the
// event loop empties -- and a log that stops mid-sentence is indistinguishable
// from a crash. This is the line that tells the two apart.
process.on("exit", (code) => say(`stopped (exit ${code})`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    say(`${signal} — shutting down`);
    void server.close().then(() => process.exit(0));
  });
}
