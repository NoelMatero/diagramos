#!/usr/bin/env node

/**
 * Make sure graphify is installed, so the deeper arrow check is simply on.
 *
 * Runs from `npm prepare`, next to the hook installer: install time is when a
 * checkout gets its tooling, and it is the one moment where taking a few
 * seconds is expected. Never at commit time -- commits stay fast.
 *
 * It only ever uses a Python tool installer that is already on the machine
 * (uv, then pipx). It never installs an installer, never touches a Python
 * environment by hand, and never fails an npm install: no installer, no
 * network, a broken package index -- all of it exits 0 quietly, and the
 * checker falls back to the one-time hint.
 *
 * Set DIAGRAMOS_SKIP_GRAPHIFY=1 (or run in CI) to skip entirely.
 */

import { spawnSync } from "node:child_process";

const PACKAGE = "graphifyy";

/** Installers we know how to drive, in the order we prefer them. */
const INSTALLERS = [
  { command: "uv", args: ["tool", "install", PACKAGE] },
  { command: "pipx", args: ["install", PACKAGE] },
];

const run = (command, args, timeout) =>
  spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
  });

/** Whether a command exists and answers, which is all "installed" can mean here. */
const answers = (command, args) => run(command, args, 20_000).status === 0;

try {
  if (process.env.DIAGRAMOS_SKIP_GRAPHIFY || process.env.CI) process.exit(0);

  // Already there: nothing to say, nothing to do.
  if (answers("graphify", ["--version"])) process.exit(0);

  const installer = INSTALLERS.find((candidate) => answers(candidate.command, ["--version"]));
  if (!installer) {
    // No uv, no pipx. Installing one of those is a decision about somebody's
    // machine that is not ours to make, so the checker's one-time hint says so
    // the first time an arrow actually goes unread.
    process.exit(0);
  }

  // Said out loud: this reaches the network and puts a tool on the machine.
  process.stderr.write(
    `diagramos: installing ${PACKAGE} with ${installer.command}, for the deeper arrow check `
    + "(set DIAGRAMOS_SKIP_GRAPHIFY=1 to skip)\n",
  );

  // Two minutes is generous for a wheel download and stingy compared to an
  // install that has silently hung.
  const install = run(installer.command, installer.args, 120_000);
  if (install.status === 0 && answers("graphify", ["--version"])) {
    process.stderr.write("diagramos: graphify ready — the deeper arrow check is on\n");
  } else {
    process.stderr.write(
      "diagramos: could not install graphify — the check works as before, arrows just go unread\n",
    );
  }
} catch {
  // Nothing here may ever fail an npm install.
}
process.exit(0);
