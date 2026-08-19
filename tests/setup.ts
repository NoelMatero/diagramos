/**
 * Grammars load once for the whole test run.
 *
 * The engine is synchronous below `initEngine`, which is what lets a drift
 * check be called from the middle of a turn. The cost of that is one await
 * somewhere near the entry point, and for tests that is here.
 */
import { beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initEngine, resetEngineCache } from "../src/engine/parse";
import { resetBodyCache } from "../src/engine/body";
import { listServers, stopServer } from "../src/server/server-registry";

/*
 * A board server records itself where `diagramos stop` can find it. That
 * registry lives in the developer's home directory, so tests are pointed at a
 * throwaway one: otherwise a test run would file entries against the real
 * registry, and `diagramos stop` would offer to stop boards that were never
 * anybody's.
 *
 * Set before any test starts, and inherited by every subprocess a test spawns,
 * which is what keeps the built CLI's servers inside the throwaway too.
 */
process.env.DIAGRAMOS_STATE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "diagramos-registry-"));

/*
 * And a port that is nobody's.
 *
 * Individual files pin their own, but a file that forgets asks for 4747 -- and
 * on any machine this tool is actually used on, that is the developer's own
 * board. The suite would then compete with it for the port, and answer "is this
 * machine quiet" alongside "is the code right" (#77).
 *
 * Set here rather than left to each file, because the failure of forgetting is
 * invisible: falling back to a free port works, so a test that took somebody's
 * board away still passes. Inherited by every subprocess a test spawns, which is
 * what puts the built CLI inside the same guarantee.
 */
process.env.DIAGRAMOS_PORT = String(
  await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") probe.close(() => resolve(address.port));
      else probe.close(() => reject(new Error("no port")));
    });
  }),
);

beforeAll(async () => { await initEngine(); });

afterAll(async () => {
  resetEngineCache();
  resetBodyCache();

  /*
   * The suite's own safety net. Four of the nine board servers found leaking on
   * this machine were left behind by test runs, so a test that forgets to close
   * one -- or is interrupted before it can -- must not be able to leave it
   * running for five days.
   *
   * It cleans rather than fails: failing here would blame whichever file
   * happened to run last for a server another one started. It says so on stderr,
   * so a forgotten close is still visible rather than quietly absorbed.
   */
  const { running } = await listServers();
  for (const entry of running) {
    console.error(`test cleanup: board server pid ${entry.pid} on port ${entry.port} was still running`);
    await stopServer(entry, { graceMs: 1000 });
  }
});
