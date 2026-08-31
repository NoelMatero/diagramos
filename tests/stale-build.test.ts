/**
 * A board service that outlived the install which started it (#181).
 *
 * The bug was not a missing feature. A service left running by an older build
 * kept answering, and answered with the vocabulary it shipped with: a board
 * carrying `@takes` and `@returns` came back with seven `garbledClaims` and
 * `clean: false`, while a fresh process on the same file reported nothing
 * wrong. The browser said four arrows were unreadable; the terminal said the
 * board was fine. One of them was inventing a red on a diagram with nothing
 * wrong with it.
 *
 * Two halves, and they fail in different places:
 *
 *   - the daemon, which must not hand back a service of another build, and
 *   - the reader, which must not call a word malformed when the board it is
 *     reading says it was drawn by something newer.
 *
 * The second is the general case: a board written by a newer install and opened
 * by an older one has the same problem with no service involved anywhere.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, readBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { TOOL_VERSION, boardIsNewer, compareVersions } from "../src/engine/version";
import { buildIdentity, staleService } from "../src/server/build-identity";
import { ensureBoardServer } from "../src/server/daemon";
import { listServers, stopServer } from "../src/server/server-registry";
import { assertFreshCliBundle } from "./helpers/fresh-bundle";

beforeAll(() => assertFreshCliBundle());

describe("comparing two versions", () => {
  it("orders releases", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });

  it("puts a prerelease before the release it leads to", () => {
    // The trap a string compare falls into in the other direction: "0.2.0-rc.5"
    // sorts after "0.2.0" as text and precedes it in fact.
    expect(compareVersions("0.2.0-rc.5", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0-rc.5")).toBe(1);
  });

  it("counts prerelease numbers rather than spelling them", () => {
    // "rc.10" < "rc.9" as text. This whole line has shipped as -rc.N.
    expect(compareVersions("0.2.0-rc.9", "0.2.0-rc.10")).toBe(-1);
  });

  it("calls anything it cannot read equal, so a bad version earns no excuse", () => {
    expect(compareVersions("not-a-version", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "")).toBe(0);
  });
});

describe("whether a board was drawn by a newer build", () => {
  it("reads an unstamped board as old, the way schemaOf does", () => {
    expect(boardIsNewer(undefined)).toBe(false);
  });

  it("says no about a board this build drew", () => {
    expect(boardIsNewer({ version: TOOL_VERSION, schema: 1 })).toBe(false);
  });

  it("says yes about a board from ahead of us", () => {
    expect(boardIsNewer({ version: "99.0.0", schema: 1 })).toBe(true);
  });
});

describe("whether a running service is still this build", () => {
  it("says nothing about a service that is this build", () => {
    expect(staleService(buildIdentity())).toBeUndefined();
  });

  it("calls a service that recorded no build stale, rather than unknown", () => {
    // The absence can only have been written by a build from before this check,
    // which is precisely the situation being fixed.
    expect(staleService(undefined)).toMatch(/before board services recorded/);
  });

  it("catches a different release", () => {
    expect(staleService({ ...buildIdentity(), version: "0.0.1" }))
      .toMatch(/running 0\.0\.1 and this is/);
  });

  it("catches a rebuild, which does not bump a version", () => {
    // The case actually reported: a local build of out/cli/serve.mjs, rebuilt on
    // disk since, both sides saying the same package version while running
    // opposite code. Version alone would have missed it entirely.
    const identity = buildIdentity();
    expect(staleService({ ...identity, builtAt: identity.builtAt - 60_000 }))
      .toMatch(/rebuilt since it started/);
  });

  it("does not call a service stale for an mtime that went backwards", () => {
    // A checkout or a restore moves mtimes down. That is not evidence the
    // running service is behind anything, and restarting on it would have a
    // board die under somebody for no reason.
    const identity = buildIdentity();
    expect(staleService({ ...identity, builtAt: identity.builtAt + 60_000 })).toBeUndefined();
  });

  it("does not compare a service of another flavour against our own directories", () => {
    /*
     * The thrash this design exists to avoid. A globally installed CLI and a
     * source checkout would otherwise take turns killing each other's service,
     * and the board would die every time the user switched. The staleness test
     * re-reads the directories the *service* recorded, so two different callers
     * get the same answer about the same service.
     */
    const elsewhere = {
      version: TOOL_VERSION,
      builtFrom: [path.join(os.tmpdir(), "diagramos-not-a-real-install")],
      builtAt: Date.now(),
    };
    expect(staleService(elsewhere)).toBeUndefined();
  });
});

describe("asking for a board service", () => {
  let state: string;
  let work: string;
  let board: string;

  beforeEach(async () => {
    state = await fs.mkdtemp(path.join(os.tmpdir(), "diagramos-181-state-"));
    process.env.DIAGRAMOS_STATE_DIR = state;
    work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "diagramos-181-work-")));
    await fs.mkdir(path.join(work, "docs/diagrams"), { recursive: true });
    board = path.join(work, "docs/diagrams/a.excalidraw");
    await fs.writeFile(board, JSON.stringify(emptyBoard(), undefined, 2));
  });

  afterEach(async () => {
    for (const entry of (await listServers()).running) await stopServer(entry);
    delete process.env.DIAGRAMOS_STATE_DIR;
    await fs.rm(state, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  });

  /** The registry entry a service wrote about itself. */
  async function entryFor(pid: number): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(path.join(state, `${pid}.json`), "utf8"));
  }

  it("records which build started it", async () => {
    const service = await ensureBoardServer({ root: work, file: board, startedBy: "a test" });
    const recorded = await entryFor(service.pid);
    expect(recorded.build).toMatchObject({ version: TOOL_VERSION });
  }, 30_000);

  it("hands back the same service when nothing has changed", async () => {
    const first = await ensureBoardServer({ root: work, file: board, startedBy: "a test" });
    const second = await ensureBoardServer({ root: work, file: board, startedBy: "a test" });
    expect(second.pid).toBe(first.pid);
    expect(second.retired ?? []).toEqual([]);
  }, 30_000);

  it("replaces a service left behind by another release, and says why", async () => {
    const first = await ensureBoardServer({ root: work, file: board, startedBy: "a test" });
    const file = path.join(state, `${first.pid}.json`);
    const recorded = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({
      ...recorded,
      build: { ...recorded.build, version: "0.0.1" },
    }));

    const second = await ensureBoardServer({ root: work, file: board, startedBy: "a test" });
    expect(second.pid).not.toBe(first.pid);
    expect(second.retired?.join(" ")).toMatch(/running 0\.0\.1/);
    // And the old one is actually gone, not merely ignored — leaving it running
    // is how a pile of invisible services starts.
    const { running } = await listServers();
    expect(running.map((entry) => entry.pid)).toEqual([second.pid]);
  }, 30_000);

  it("replaces a service whose code was rebuilt underneath it", async () => {
    const first = await ensureBoardServer({ root: work, file: board, startedBy: "a test" });
    const file = path.join(state, `${first.pid}.json`);
    const recorded = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({
      ...recorded,
      build: { ...recorded.build, builtAt: recorded.build.builtAt - 60_000 },
    }));

    const second = await ensureBoardServer({ root: work, file: board, startedBy: "a test" });
    expect(second.pid).not.toBe(first.pid);
    expect(second.retired?.join(" ")).toMatch(/rebuilt since it started/);
  }, 30_000);
});

describe("reading a board that a newer build drew", () => {
  let work: string;

  beforeAll(async () => {
    await initEngine();
  });

  beforeEach(async () => {
    work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "diagramos-181-read-")));
    await fs.mkdir(path.join(work, "src"), { recursive: true });
    await fs.writeFile(
      path.join(work, "src/a.ts"),
      "export function one() { return 1; }\nexport function two() { return one(); }\n",
    );
  });

  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  /** A board with one arrow claiming a word no vocabulary has. */
  async function boardWithUnknownClaim(): Promise<BoardFile> {
    const file = path.join(work, "board.excalidraw");
    await fs.writeFile(file, JSON.stringify(emptyBoard(), undefined, 2));
    const { board } = await createDiagram(await readBoard(file), {
      nodes: [
        { id: "one", label: "one", ref: "src/a.ts#one" },
        { id: "two", label: "two", ref: "src/a.ts#two" },
      ],
      edges: [{ from: "one", to: "two", label: "@teleports" }],
    });
    return board;
  }

  it("still calls a typo a typo on a board this build drew", async () => {
    const report = checkDrift(await boardWithUnknownClaim(), createWorkspace(work));
    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0]?.cause ?? "vocabulary").toBe("vocabulary");
    expect(report.garbledClaims[0]?.detail).toMatch(/is not something an arrow can claim/);
  });

  it("still calls a typo a typo on a board with no stamp at all", async () => {
    // Stamping began mid-line, so an unstamped board is an old board, not an
    // unknown one — and an old board's typos are typos.
    const drawn = await boardWithUnknownClaim();
    const unstamped = { ...drawn, diagramos: undefined } as unknown as BoardFile;
    const report = checkDrift(unstamped, createWorkspace(work));
    expect(report.garbledClaims[0]?.detail).toMatch(/is not something an arrow can claim/);
  });

  it("blames itself, not the board, when the board is from ahead of it", async () => {
    const drawn = await boardWithUnknownClaim();
    const future = { ...drawn, diagramos: { version: "99.0.0", schema: 1 } } as BoardFile;
    const report = checkDrift(future, createWorkspace(work));
    expect(report.garbledClaims[0]?.cause).toBe("older-build");
    expect(report.garbledClaims[0]?.detail).toContain("@teleports");
    expect(report.garbledClaims[0]?.detail).toMatch(/update diagramos rather than changing the board/);
  });

  it("stays loud about it, because nothing checked the claim either way", async () => {
    /*
     * The temptation is to go quiet, and it is the wrong trade. A claim nobody
     * judged reads exactly like a claim that passed, and that is true whoever's
     * fault it is. What changes is the diagnosis, not the volume.
     */
    const drawn = await boardWithUnknownClaim();
    const future = { ...drawn, diagramos: { version: "99.0.0", schema: 1 } } as BoardFile;
    expect(checkDrift(future, createWorkspace(work)).clean).toBe(false);
  });
});
