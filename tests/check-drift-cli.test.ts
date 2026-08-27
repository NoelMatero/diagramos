/**
 * The drift check as a person meets it: a command line and a Stop hook.
 *
 * The engine is covered by engine-drift.test.ts. What is covered here is the
 * surface that decides whether anyone acts on a finding — the exit code, and
 * whether the report says what to do. Being told a diagram is stale without
 * being told that anything can be done about it is where this stopped being
 * useful, and the guidance line was previously printed only to a terminal, so
 * from a hook — the way it actually runs — nobody ever saw it.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_FILE } from "../src/engine/config";
import { emptyBoard, writeBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const run = promisify(execFile);
const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts/check-drift.mjs");
/**
 * This repo's own tsx, not `npx tsx`.
 *
 * These runs happen from a temp project with no node_modules, so npx resolves
 * nothing there, fetches tsx from the registry and prints `npm warn exec ...` to
 * stderr — which fails the silence check below. It passed locally anyway because
 * the npx cache was already warm, and only failed in CI. Naming the binary makes
 * the test say the same thing on every machine, and removes a network call.
 */
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let workspace: string;

/** Runs the check the way a hook does: from the project directory, not this repo. */
async function checkDrift(): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT], { cwd: workspace });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * What the report actually reported, with the one-line summary a bare run now
 * ends with removed.
 *
 * Most assertions below were written as "not a single byte", which was a fair
 * proxy for "said nothing about this box" back when a clean bare run printed
 * nothing at all. It answers in one line now, so the proxy breaks while every
 * one of those intents still holds — and the intent is the thing worth pinning.
 * The summary itself is asserted once, on its own, so nothing here is covering
 * for it going missing.
 *
 * The code-graph line goes the same way, and for the same reason: it is said
 * once per checkout, it is about this machine's tooling rather than about any
 * board, and whether it appears depends on whether graphify happens to be
 * installed where the tests run — which is how it caught a green local suite and
 * a red CI one. Its own tests are in `code-graph-build.test.ts`.
 */
function findings(output: string): string {
  return output
    .split("\n")
    .filter((line) => !line.includes("nothing drifted"))
    .filter((line) => !line.includes("code graph") && !line.includes("graphify"))
    .join("\n")
    .trim();
}

async function board(nodes: Array<{ id: string; label: string; ref?: string }>) {
  return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] })).board;
}

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "drift-cli-"));
  mkdirSync(path.join(workspace, "docs/diagrams"), { recursive: true });
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(path.join(workspace, "src/present.ts"), "export const present = true;\n");
}, 120_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("check-drift on the command line", () => {
  it("answers in one line when every box still points at real code", async () => {
    await writeBoard(
      path.join(workspace, "docs/diagrams/clean.excalidraw"),
      await board([{ id: "p", label: "Present", ref: "src/present.ts" }]),
    );
    const result = await checkDrift();
    expect(result.code).toBe(0);
    /*
     * This used to assert total silence, with the reasoning that the check runs
     * every turn and one announcing good news gets switched off. The reasoning
     * is right and was applied to the wrong caller: the per-turn path is
     * `--hook`, which is still silent and is pinned to be, below. This path is
     * somebody typing a command, and silence there reads as a broken install --
     * which is how it was actually read.
     */
    const said = `${result.stdout}${result.stderr}`.trim();
    expect(said).toContain("nothing drifted");
    // One line, not a report. The quiet is worth protecting even here.
    expect(said.split("\n")).toHaveLength(1);
  }, 120_000);

  it("reports the stale box, names the file, and exits non-zero", async () => {
    await writeBoard(
      path.join(workspace, "docs/diagrams/stale.excalidraw"),
      await board([
        { id: "p", label: "Present", ref: "src/present.ts" },
        { id: "g", label: "Old Cache", ref: "src/gone.ts" },
      ]),
    );
    const result = await checkDrift();
    // Non-zero because that is the only channel a Stop hook actually shows, and
    // what CI and a pre-commit hook want besides.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stale.excalidraw");
    expect(result.stderr).toContain("Old Cache");
    expect(result.stderr).toContain("src/gone.ts");
  }, 120_000);

  it("tells the reader how to fix it, from a hook and not only from a terminal", async () => {
    // execFile pipes the child's stderr, so it is not a TTY — exactly a hook's
    // situation, and exactly the case the old TTY-gated guidance stayed silent in.
    const result = await checkDrift();
    expect(result.stderr).toContain("/update-diagram");
  }, 120_000);

  it("does not name a box whose code is still there", async () => {
    const result = await checkDrift();
    expect(result.stderr).not.toContain("Present");
    expect(result.stderr).not.toContain("clean.excalidraw");
  }, 120_000);
});

describe("claims on the command line", () => {
  /*
   * Its own project, for the reason the block below has one, and because this is
   * the only place the two halves of the claim slot can be seen together: a word
   * that is not a claim has to reach the notice, and a claim that *is* a claim
   * has to leave the notice exactly as it found it.
   */
  let project: string;

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  async function write(name: string, edge: { label?: string; claim?: "needs" }) {
    const { board } = await createDiagram(emptyBoard(), {
      name,
      nodes: [
        { id: "reader", label: "Reader", ref: "src/reader.ts" },
        { id: "store", label: "Store", ref: "src/store.ts" },
      ],
      edges: [{ from: "reader", to: "store", ...edge }],
    });
    await writeBoard(path.join(project, `docs/diagrams/${name}.excalidraw`), board);
  }

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-claims-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    // reader imports store, so the arrow is corroborated and the check is quiet
    // about it. Whatever the claim does, it does on top of silence.
    writeFileSync(path.join(project, "src/store.ts"), "export const store = 1;\n");
    writeFileSync(
      path.join(project, "src/reader.ts"),
      "import { store } from './store';\nexport const reader = store;\n",
    );
  });

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("says nothing new about an arrow that claims needs", async () => {
    await write("claimed", { claim: "needs" });
    const claimed = await check();
    rmSync(project, { recursive: true, force: true });

    // The same board again, claim removed, checked from a fresh project.
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-claims-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/store.ts"), "export const store = 1;\n");
    writeFileSync(
      path.join(project, "src/reader.ts"),
      "import { store } from './store';\nexport const reader = store;\n",
    );
    await write("claimed", {});
    const bare = await check();

    expect(claimed.code).toBe(bare.code);
    expect(`${claimed.stdout}${claimed.stderr}`).toBe(`${bare.stdout}${bare.stderr}`);
  }, 120_000);

  it("is loud about a word that is not a claim, and exits non-zero", async () => {
    await write("typo", { label: "@need" });
    const result = await check();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("typo.excalidraw");
    expect(result.stderr).toContain("Reader");
    expect(result.stderr).toContain("@need is not a claim");
    // Its own word in the tally: an unreadable claim is not an arrow the code
    // failed to corroborate.
    expect(result.stderr).toContain("1 unreadable");
  }, 120_000);

  it("says in the long form that the claim was checked for direction", async () => {
    await write("claimed", { claim: "needs" });
    const result = await check("--details");
    expect(`${result.stdout}${result.stderr}`).toContain("1 needs arrow checked for direction");
  }, 120_000);

  it("calls a backwards claim wrong, names the fix, and exits non-zero", async () => {
    // Same two files, arrow turned round: store does not import reader.
    const { board } = await createDiagram(emptyBoard(), {
      name: "backwards",
      nodes: [
        { id: "reader", label: "Reader", ref: "src/reader.ts" },
        { id: "store", label: "Store", ref: "src/store.ts" },
      ],
      edges: [{ from: "store", to: "reader", claim: "needs" }],
    });
    await writeBoard(path.join(project, "docs/diagrams/backwards.excalidraw"), board);

    const result = await check();
    const output = `${result.stdout}${result.stderr}`;
    expect(result.code).toBe(1);
    expect(output).toContain("backwards.excalidraw");
    expect(output).toContain("drawn backwards");
    // The direction to fix it, in the row itself: this is the one arrow row that
    // can say which way round it should have been.
    expect(output).toContain("should be");
  }, 120_000);

  it("says nothing about a backwards arrow that carries no claim", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "unclaimed",
      nodes: [
        { id: "reader", label: "Reader", ref: "src/reader.ts" },
        { id: "store", label: "Store", ref: "src/store.ts" },
      ],
      edges: [{ from: "store", to: "reader" }],
    });
    await writeBoard(path.join(project, "docs/diagrams/unclaimed.excalidraw"), board);

    const result = await check();
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("backwards");
  }, 120_000);
});

describe("an arrow nothing corroborates, on the command line", () => {
  // Its own project, because the boards above accumulate: once stale.excalidraw
  // exists that workspace exits 1 forever, and the --no-edges silence below
  // would have nothing left to prove.
  let project: string;

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-edges-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    // Both files exist, so the missing-file check stays quiet. Nothing imports,
    // mentions, or shares a string with anything — the drawn arrow is the only
    // claim of a relationship, and it is not a claim any channel here can put to
    // the code either way.
    writeFileSync(path.join(project, "src/left.ts"), "export const left = 1;\n");
    writeFileSync(path.join(project, "src/right.ts"), "export const right = 1;\n");
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "edges",
      nodes: [
        { id: "left", label: "Left", ref: "src/left.ts" },
        { id: "right", label: "Right", ref: "src/right.ts" },
      ],
      edges: [{ from: "left", to: "right" }],
    });
    await writeBoard(path.join(project, "docs/diagrams/edges.excalidraw"), drawn);
  }, 120_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("says nothing about it, and does not fail the build over it", async () => {
    /*
     * The whole of #133 at the surface. This arrow used to be amber, listed and
     * counted, and exit 1 -- on the strength of nobody having found anything.
     * Every channel here only confirms, so there was never a fact behind it:
     * fifteen of the seventeen ambers on the first Rust board an agent drew were
     * arrows exactly like this one, carrying a descriptive label and no claim.
     */
    const result = await check();
    expect(result.code).toBe(0);
    const said = `${result.stdout}${result.stderr}`;
    expect(findings(said)).toBe("");
  }, 120_000);

  it("counts it where a reader asked how much was verified", async () => {
    // Quiet is not the same as hidden. --details is the flag whose whole job is
    // saying what was and was not read, and this is the honest half of what the
    // amber used to carry: the arrow, by both box labels, and why nothing came
    // back.
    const result = await check("--details");
    expect(result.stderr).toContain("1 arrow read and not confirmed");
    expect(result.stderr).toContain("no import, shared importer");
    expect(result.stderr).toContain("Left");
    expect(result.stderr).toContain("Right");
    // Still not a verdict, in any wording.
    expect(result.stderr.toLowerCase()).not.toContain("wrong");
    expect(result.stderr).not.toContain("gone");
  }, 120_000);

  it("--no-edges turns off just this check, so even the count goes away", async () => {
    const result = await check("--no-edges", "--details");
    // The files all exist, so with edges off there is nothing to say — and the
    // point of the separate flag is that the arrow check can be silenced
    // without losing the missing-file check.
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("not confirmed");
  }, 120_000);
});

/**
 * How a report with a lot in it reads.
 *
 * The failure this guards against is not wrongness, it is length: twelve arrow
 * findings all fail for the same reason, and printing that reason once per arrow
 * produced a wall of near-identical lines — 2360 characters for twelve arrows,
 * measured — which is a report nobody reads to the end. Saying it once and
 * listing the arrows brings the same information to 477.
 *
 * Twelve arrows drawn backwards, since #133: an arrow nothing corroborates is no
 * longer a finding at all, so the only way to get twelve arrow findings on one
 * board is twelve claims the code contradicts. The shape under test is the same
 * one — many rows, one kind, one reason.
 */
describe("a report with many findings stays readable", () => {
  const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
  let project: string;
  let stderr: string;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-many-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    // Every file exists, so the missing-file check stays quiet, and every one of
    // the twelve imports `a` — while each arrow claims that `a` needs *it*. The
    // dependency runs the other way in all twelve, by a line the check can
    // quote, which is what makes them findings rather than a tally.
    writeFileSync(path.join(project, "src/a.ts"), "export const a = 1;\n");
    for (const name of NAMES.slice(1)) {
      writeFileSync(
        path.join(project, `src/${name}.ts`),
        `import { a } from "./a";\nexport const ${name} = a;\n`,
      );
    }
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "many",
      nodes: NAMES.map((name) => ({ id: name, label: name.toUpperCase(), ref: `src/${name}.ts` })),
      edges: NAMES.slice(1).map((name) => ({ from: "a", to: name, claim: "needs" as const })),
    });
    await writeBoard(path.join(project, "docs/diagrams/many.excalidraw"), drawn);

    try {
      await run(TSX, [SCRIPT], { cwd: project });
      stderr = "";
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? "";
    }
  }, 180_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("does not explain itself at all — the marker carries it", () => {
    // This fires at the end of every turn. The explanation was printed once per
    // arrow (2360 characters for twelve), then once per report, and is now in the
    // documentation where it is read once.
    expect(stderr).not.toContain("no shared importer");
    expect(stderr).not.toContain("worth a look");
    // And no colour when the output is captured: escapes in a log or a CI
    // transcript are noise.
    expect(stderr).not.toContain("\\u001b[");
  });

  it("counts every finding even though it lists only the first few", () => {
    // The count rides in the heading: "many.excalidraw  12 arrows".
    expect(stderr).toMatch(/12 arrows/);
    expect(stderr).toMatch(/… and \d+ more/);
    // The count in the heading is what makes trimming honest rather than hiding.
    // Arrow lines are indented under their heading; the exact indent is the
    // format's business, the count is the contract.
    const listed = (stderr.match(/│ A → /g) ?? []).length;
    const hidden = Number(/… and (\d+) more/.exec(stderr)?.[1] ?? 0);
    expect(listed + hidden).toBe(12);
  });

  it("stays short enough to read", () => {
    // The old format spent 2360 characters on this exact case.
    expect(stderr.length).toBeLessThan(800);
  });
});

/**
 * The Stop hook channel.
 *
 * Measured, not assumed, and it took three probes to establish: plain text on
 * stdout with exit 0 is discarded; stderr with a non-zero exit shows but Claude
 * Code wraps it in "Stop hook error: Failed with non-blocking status code",
 * which reads as a broken tool rather than a finding; structured JSON on stdout
 * renders as an ordinary notice, with newlines, indentation and box-drawing
 * characters surviving.
 *
 * So the exit code has to differ by caller — 0 for the hook, non-zero for CI —
 * and that is worth pinning, because getting it backwards either loses the
 * report entirely or fails somebody's build on a diagram.
 */
describe("the hook channel", () => {
  let project: string;

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-hook-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "hook",
      nodes: [{ id: "gone", label: "Old Cache", ref: "src/cache.ts" }],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/hook.excalidraw"), drawn);
  }, 120_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("delivers the report as a systemMessage and exits 0", async () => {
    const result = await check("--hook");
    // Non-zero here is what produced the "Stop hook error: Failed" framing.
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(payload.systemMessage).toContain("Old Cache");
    expect(payload.systemMessage).toContain("/update-diagram");
    // Nothing on stderr in hook mode: it would be discarded, and a report that
    // exists in a channel nobody reads is the failure this whole thing is about.
    expect(result.stderr.trim()).toBe("");
  }, 120_000);

  it("still fails a build when it is not a hook", async () => {
    const result = await check();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Old Cache");
    expect(result.stdout.trim()).toBe("");
  }, 120_000);

  it("stays completely silent as a hook when the diagram is fine", async () => {
    const clean = mkdtempSync(path.join(tmpdir(), "drift-cli-hook-clean-"));
    mkdirSync(path.join(clean, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(clean, "src"), { recursive: true });
    try {
      // A real board pointing at real code. This used to be an empty directory,
      // which is a different kind of quiet entirely -- and the reason the check
      // could go blind on a misplaced board while this test stayed green.
      writeFileSync(path.join(clean, "src/present.ts"), "export const present = true;\n");
      await writeBoard(
        path.join(clean, "docs/diagrams/clean.excalidraw"),
        await board([{ id: "p", label: "Present", ref: "src/present.ts" }]),
      );
      /*
       * This is the silence that matters, and now the only one asserted here.
       *
       * It fires unbidden at the end of every turn. A summary on a clean board
       * would be a notice thirty times an hour saying nothing happened, which is
       * how somebody comes to switch the check off -- taking the quiet, correct
       * missing-file check with it. The bare command answers instead, and that
       * asymmetry is deliberate rather than an oversight; the command-line case
       * is pinned above.
       */
      const { stdout, stderr } = await run(TSX, [SCRIPT, "--hook"], { cwd: clean });
      expect(`${stdout}${stderr}`.trim()).toBe("");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * Colour, and where it is allowed to go.
 *
 * ANSI does render inside a Claude Code systemMessage — measured by putting real
 * escapes in one and looking, after an earlier round concluded the opposite from a
 * copy-paste, where colour is invisible either way. That is why severity is colour
 * and not emoji: colour occupies no cells and cannot shear a padded row, while
 * `⚠️` is ambiguous-width and did.
 *
 * It must not reach a pipe though, and that is the half a test can check.
 */
describe("colour", () => {
  const RED = "\u001b[31m";
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-colour-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "colour",
      nodes: [{ id: "gone", label: "Old Cache", ref: "src/cache.ts" }],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/colour.excalidraw"), drawn);
  }, 120_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("paints the notice, because the notice renders it", async () => {
    const { stdout } = await run(TSX, [SCRIPT, "--hook"], { cwd: project });
    const payload = JSON.parse(stdout) as { systemMessage: string };
    expect(payload.systemMessage).toContain(RED);
  }, 120_000);

  it("leaves captured output plain", async () => {
    try {
      await run(TSX, [SCRIPT], { cwd: project });
      throw new Error("expected a non-zero exit");
    } catch (error) {
      const failure = error as { stderr?: string };
      expect(failure.stderr).toContain("Old Cache");
      expect(failure.stderr).not.toContain("\u001b[");
    }
  }, 120_000);

  it("switches to the notice when hook JSON arrives on stdin, with no flag", () => {
    // execFile ignores `input`; only the sync form actually writes to stdin, which
    // is why an earlier version of this test proved nothing.
    const stdout = execFileSync(TSX, [SCRIPT], {
      cwd: project,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "test" }),
      encoding: "utf8",
    });
    const payload = JSON.parse(stdout) as { systemMessage: string };
    // The flag is a trap otherwise: forget it and the report comes back wrapped in
    // "Stop hook error: Failed", which reads as a broken tool rather than a finding.
    expect(payload.systemMessage).toContain("Old Cache");
  }, 120_000);

  it("survives stdin being /dev/null rather than a pipe", () => {
    // process.stdin is a socket when piped and an fs stream when redirected from a
    // file or /dev/null, and only the socket has unref(). Every test here used a
    // pipe, so a crash on the other shape went unnoticed until a shell ran it.
    const stdout = execFileSync(TSX, [SCRIPT, "--hook"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(JSON.parse(stdout).systemMessage).toContain("Old Cache");
  }, 120_000);

  it("starts the notice on its own line, so the harness prefix cannot shift the border", async () => {
    const { stdout } = await run(TSX, [SCRIPT, "--hook"], { cwd: project });
    const payload = JSON.parse(stdout) as { systemMessage: string };
    // "Stop says: ┌───" pushed the top border right by the width of that prefix.
    expect(payload.systemMessage.startsWith("\n")).toBe(true);
  }, 120_000);
});

/**
 * The expanded view behind `--details`.
 *
 * The notice is trimmed because it fires every turn; this is what someone gets when
 * they ask. What it must not do is grow a second personality: same rows, same
 * colours, one box per diagram, nothing capped, and the command once at the bottom.
 */
describe("--details", () => {
  const MANY = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-details-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    // Twelve files importing `a`, against twelve arrows claiming `a` needs them.
    writeFileSync(path.join(project, "src/a.ts"), "export const a = 1;\n");
    for (const name of MANY.slice(1)) {
      writeFileSync(
        path.join(project, `src/${name}.ts`),
        `import { a } from "./a";\nexport const ${name} = a;\n`,
      );
    }
    const { board: first } = await createDiagram(emptyBoard(), {
      name: "one",
      nodes: MANY.map((name) => ({ id: name, label: name.toUpperCase(), ref: `src/${name}.ts` })),
      // Backwards, all twelve, for the reason the box above this describe gives:
      // an arrow nothing corroborates is a count now, not a finding (#133), and
      // what is under test here is how a long list of findings prints.
      edges: MANY.slice(1).map((name) => ({ from: "a", to: name, claim: "needs" as const })),
    });
    await writeBoard(path.join(project, "docs/diagrams/one.excalidraw"), first);

    const { board: second } = await createDiagram(emptyBoard(), {
      name: "two",
      nodes: [{ id: "gone", label: "Old Cache", ref: "src/cache.ts" }],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/two.excalidraw"), second);
  }, 180_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function details() {
    try {
      execFileSync(TSX, [SCRIPT, "--details"], { cwd: project, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      return "";
    } catch (error) {
      return (error as { stderr?: string }).stderr ?? "";
    }
  }

  it("lists every finding, where the notice would have trimmed to six", () => {
    const out = details();
    const arrows = (out.match(/│ A → /g) ?? []).length;
    expect(arrows).toBe(12);
    expect(out).not.toContain("more");
  }, 180_000);

  it("gives each diagram its own box, headed by its own counts", () => {
    const out = details();
    expect(out).toContain("one.excalidraw");
    expect(out).toContain("two.excalidraw");
    expect(out).toContain("12 arrows");
    expect(out).toContain("1 gone");
    // One frame for the findings, not two boxes: the second diagram is introduced
    // by a divider, so there is a single top border and a single bottom one.
    //
    // Sliced from the last top border, because --details now also prints the
    // audit of what was and was not checked, in its own frame above this one.
    // They are separate frames on purpose: one lists what is wrong, the other
    // says how much was read, and folding them together would blur that.
    const findings = out.slice(out.lastIndexOf("┌"));
    expect((findings.match(/┌/g) ?? []).length).toBe(1);
    expect((findings.match(/├/g) ?? []).length).toBe(1);
    expect((findings.match(/└/g) ?? []).length).toBe(1);
  }, 180_000);

  it("names the command once, under everything", () => {
    const out = details();
    expect((out.match(/\/update-diagram/g) ?? []).length).toBe(1);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.at(-1)).toContain("/update-diagram");
  }, 180_000);
});

/**
 * The arrows the audit could not read, by name.
 *
 * `--details` already said how many went unread and why. A reason with no
 * subject cannot be acted on: "4 arrows skipped: an end is marked external" gives
 * a reader no way to find which four short of opening the engine, which is how a
 * false arrow survived on this repo's own example board from the first commit.
 */
describe("--details names the arrows nothing read", () => {
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-unread-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/engine.ts"), "export const plan = 1;\n");
    const { board } = await createDiagram(emptyBoard(), {
      name: "mixed",
      nodes: [
        { id: "engine", label: "ELK layout engine", ref: "src/engine.ts" },
        { id: "file", label: "board.excalidraw", state: "external" },
        { id: "human", label: "You", state: "external" },
      ],
      edges: [
        { from: "engine", to: "file", label: "writes" },
        { from: "human", to: "file", label: "edits" },
      ],
    });
    await writeBoard(path.join(project, "docs/diagrams/mixed.excalidraw"), board);

    // Ten of one reason, to prove the cap says what it kept back.
    const many = Array.from({ length: 10 }, (_, index) => `out${index}`);
    const { board: crowded } = await createDiagram(emptyBoard(), {
      name: "crowded",
      nodes: [
        { id: "engine", label: "Engine", ref: "src/engine.ts" },
        ...many.map((id) => ({ id, label: id.toUpperCase(), state: "external" as const })),
      ],
      edges: many.map((id) => ({ from: "engine", to: id })),
    });
    await writeBoard(path.join(project, "docs/diagrams/crowded.excalidraw"), crowded);
  }, 180_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  /*
   * Reads stderr, and reads it on a clean exit too.
   *
   * Both halves matter here and neither is true of the sync helpers above. The
   * report is written to stderr, so a helper returning `execFileSync`'s stdout
   * gets "" no matter what was printed; and this board has nothing wrong with
   * it, so the run exits 0 and never reaches a catch block. Either mistake
   * passes the negative test below for entirely the wrong reason.
   */
  async function at(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return stdout + stderr;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return (failure.stdout ?? "") + (failure.stderr ?? "");
    }
  }

  it("names them by their box labels and carries the arrow's own word", async () => {
    const out = await at("--details");
    expect(out).toContain("2 arrows skipped");
    expect(out).toContain("ELK layout engine → board.excalidraw");
    expect(out).toContain("writes");
    expect(out).toContain("You → board.excalidraw");
  }, 180_000);

  it("stops at a readable number and says how many it kept back", async () => {
    // A list that quietly stopped at eight would be the same failure as a count:
    // it would read as "that is all of them".
    const out = await at("--details");
    const crowded = out.slice(out.indexOf("crowded.excalidraw"));
    expect(crowded).toContain("10 arrows skipped");
    expect((crowded.match(/Engine → OUT/g) ?? []).length).toBe(8);
    expect(crowded).toContain("+2 more");
  }, 180_000);

  it("says nothing about them on the per-turn run, which has to stay quiet", async () => {
    // The whole point of the audit living behind a flag: a check that nags every
    // turn is a check somebody switches off.
    const out = await at();
    expect(out).not.toContain("ELK layout engine → board.excalidraw");
  }, 180_000);
});

/**
 * How much the notice says, which is deliberately not much.
 *
 * One diagram lists what is wrong with it; several list themselves with counts.
 * The alternative — listing findings whenever they fitted — was built, seen, and
 * reverted: it made the ordinary two-diagram case longer than the counts it
 * replaced, in a notice that fires at the end of every turn.
 */
describe("how much the notice says", () => {
  let project: string;

  async function notice() {
    const stdout = execFileSync(TSX, [SCRIPT, "--hook"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return (JSON.parse(stdout) as { systemMessage: string }).systemMessage;
  }

  beforeAll(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-fit-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
  });

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  async function board(name: string, boxes: number) {
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name,
      nodes: Array.from({ length: boxes }, (_, index) => ({
        id: `${name}${index}`,
        label: `${name.toUpperCase()}${index}`,
        ref: `src/${name}${index}.ts`,
      })),
      edges: [],
    });
    await writeBoard(path.join(project, `docs/diagrams/${name}.excalidraw`), drawn);
  }

  it("counts a second diagram rather than listing its findings", async () => {
    await board("alpha", 2);
    await board("beta", 2);
    const message = await notice();
    // Four findings across two diagrams would fit, and are still not listed: a
    // notice firing every turn stays short, and /expand-report is there for the
    // rest. Listing them was tried, and made the common case longer.
    expect(message).not.toContain("ALPHA0 →");
    expect(message).toContain("alpha.excalidraw");
    expect(message).toContain("beta.excalidraw");
    expect(message).toContain("/expand-report");
  }, 180_000);

  it("falls back to counts, and points at the fuller view, when they do not", async () => {
    await board("gamma", 8);
    const message = await notice();
    expect(message).toContain("gamma.excalidraw");
    expect(message).toContain("/expand-report");
    // Counts per diagram rather than twelve rows of findings.
    expect(message).toMatch(/8 gone/);
  }, 180_000);
});

/**
 * Expanding as a mode, not a one-off.
 *
 * A command cannot reach into a notice the hook has already written, so making
 * /expand-report affect *later* notices means leaving a preference behind. It lives
 * in .diagramos/, which is gitignored, so it is one person's and not the repo's.
 *
 * The standing objection to a mode is that it is invisible once set. That is
 * answered by the notice itself: while expanded, it names the way back.
 */
describe("expand as a mode", () => {
  let project: string;

  function run(...args: string[]) {
    try {
      return execFileSync(TSX, [SCRIPT, ...args], {
        cwd: project,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (error) {
      return (error as { stderr?: string }).stderr ?? "";
    }
  }

  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-mode-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    for (const name of ["one", "two"]) {
      const { board: drawn } = await createDiagram(emptyBoard(), {
        name,
        nodes: [{ id: `${name}gone`, label: `${name} box`, ref: `src/${name}.ts` }],
        edges: [],
      });
      await writeBoard(path.join(project, `docs/diagrams/${name}.excalidraw`), drawn);
    }
  }, 180_000);

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("counts by default, with two diagrams stale", () => {
    expect(run()).toContain("2 diagrams out of date");
  }, 180_000);

  it("stays expanded on later runs, and says how to undo it", () => {
    run("--expand");
    const next = run();
    expect(next).toContain("one box →");
    expect(next).toContain("two box →");
    // A mode nobody can find the exit from is the thing to avoid.
    expect(next).toContain("/shrink-report");
  }, 180_000);

  it("goes back to counts after --shrink, and stays there", () => {
    run("--shrink");
    const next = run();
    expect(next).toContain("2 diagrams out of date");
    expect(next).not.toContain("one box →");
  }, 180_000);

  it("--details shows everything without turning the mode on", () => {
    const once = run("--details");
    expect(once).toContain("one box →");
    // The next notice is short again: --details changed nothing.
    expect(run()).toContain("2 diagrams out of date");
  }, 180_000);
});

/** Runs the check in some other project, with arguments. */
async function checkDriftIn(
  cwd: string,
  args: string[] = [],
): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * Silence means "nothing drifted". It used to also mean "nothing was looked at",
 * and the two are opposite news.
 */
describe("nothing to check is not the same as nothing wrong", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-nothing-"));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("says the diagram directory is missing rather than exiting silently", async () => {
    const result = await checkDriftIn(project);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("does not exist");
  }, 120_000);

  it("says the directory is empty when it exists with no boards in it", async () => {
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    const result = await checkDriftIn(project);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("no .excalidraw files");
  }, 120_000);

  it("does not report clean when the boards sit one directory off", async () => {
    // The bug this exists for: a board in diagrams/ rather than docs/diagrams/
    // produced exit 0 and no output, indistinguishable from every box checking
    // out. Wired into a Stop hook, that is a project believing it is guarded.
    mkdirSync(path.join(project, "diagrams"), { recursive: true });
    await writeBoard(
      path.join(project, "diagrams/arch.excalidraw"),
      await board([{ id: "p", label: "Present", ref: "src/present.ts" }]),
    );
    const result = await checkDriftIn(project);
    expect(`${result.stdout}${result.stderr}`.trim()).not.toBe("");
  }, 120_000);

  it("stays silent through the hook, which fires every turn", async () => {
    // A project with no diagrams must not be told so once per turn for its
    // whole life; quiet is what keeps this check switched on.
    const result = await checkDriftIn(project, ["--hook"]);
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
  }, 120_000);
});

/**
 * A project whose diagrams are not where the check looks, and a project that
 * says where they are instead.
 */
describe("the diagram directory", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-dir-"));
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/present.ts"), "export const present = true;\n");
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  async function boardAt(relative: string) {
    const file = path.join(project, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    await writeBoard(file, await board([{ id: "p", label: "Present", ref: "src/present.ts" }]));
  }

  it("names the boards it found elsewhere when it had nothing to check", async () => {
    await boardAt("diagrams/arch.excalidraw");
    await boardAt("docs/auth.excalidraw");
    const result = await checkDriftIn(project);
    expect(result.stderr).toContain("nothing to check");
    expect(result.stderr).toContain("found 2 elsewhere");
    expect(result.stderr).toContain(path.join("diagrams", "arch.excalidraw"));
    expect(result.stderr).toContain(path.join("docs", "auth.excalidraw"));
    // The way out, or the reader is only told they have a problem.
    expect(result.stderr).toContain(CONFIG_FILE);
  }, 120_000);

  it("does not go hunting through the repository when it did have boards", async () => {
    // The search reads every directory that is not obviously machinery, which is
    // fine on demand and pointless once there is something to report on.
    await boardAt("docs/diagrams/clean.excalidraw");
    await boardAt("diagrams/stray.excalidraw");
    const result = await checkDriftIn(project);
    expect(findings(`${result.stdout}${result.stderr}`)).toBe("");
  }, 120_000);

  it("checks the directory the project asked for", async () => {
    await boardAt("docs/architecture/system.excalidraw");
    writeFileSync(path.join(project, CONFIG_FILE), JSON.stringify({ diagrams: "docs/architecture" }));
    const result = await checkDriftIn(project);
    // Found and checked: no complaint about there being nothing to look at.
    expect(findings(`${result.stdout}${result.stderr}`)).toBe("");
  }, 120_000);

  it("refuses a config it cannot honour instead of quietly using the default", async () => {
    await boardAt("docs/diagrams/clean.excalidraw");
    writeFileSync(path.join(project, CONFIG_FILE), "{oops");
    const result = await checkDriftIn(project);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
  }, 120_000);

  it("sends a broken config through the hook's own channel", async () => {
    // stderr from a hook is discarded, so a config error reported there would be
    // a check silently doing nothing -- the failure mode all over again.
    writeFileSync(path.join(project, CONFIG_FILE), JSON.stringify({ diagrams: "../escape" }));
    const result = await checkDriftIn(project, ["--hook"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(payload.systemMessage).toContain("stay inside the project");
  }, 120_000);
});

/**
 * State on the command line. The engine decides what a planned box means;
 * what matters here is the thing the engine cannot get right on its own —
 * whether a design session gets nagged, and whether a build fails over a sketch.
 */
describe("check-drift and what a diagram says about time", () => {
  let project: string;

  async function stateBoard(
    nodes: Array<{ id: string; label: string; ref?: string; state?: "planned" | "built" | "external" }>,
  ) {
    const built = await createDiagram(emptyBoard(), { name: "arch", nodes, edges: [] });
    await writeBoard(path.join(project, "docs/diagrams/plan.excalidraw"), built.board);
  }

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-state-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("says nothing about a planned box the code has not reached", async () => {
    // The whole design session would otherwise get the same notice every turn.
    await stateBoard([{ id: "s", label: "Session store", ref: "src/sessions.ts", state: "planned" }]);
    const result = await check();
    expect(findings(result.stderr)).toBe("");
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  });

  it("lists that planned box when someone asks for details", async () => {
    // Being quiet is not the same as withholding: --details was asked for.
    await stateBoard([{ id: "s", label: "Session store", ref: "src/sessions.ts", state: "planned" }]);
    const result = await check("--details");
    expect(result.stderr).toContain("Session store");
    expect(result.stderr).toContain("not built yet");
    expect(result.code).toBe(0);
  });

  it("speaks up once the code catches up, and still does not fail a build", async () => {
    writeFileSync(path.join(project, "src/sessions.ts"), "export const store = 1;\n");
    await stateBoard([{ id: "s", label: "Session store", ref: "src/sessions.ts", state: "planned" }]);
    const result = await check();
    expect(result.stderr).toContain("Session store is built now");
    // Good news must not turn CI red.
    expect(result.code).toBe(0);
  });

  it("still fails on a built box whose file is gone, and counts the sketch beside it", async () => {
    await stateBoard([
      { id: "gone", label: "Deleted module", ref: "src/gone.ts" },
      { id: "s", label: "Session store", ref: "src/sessions.ts", state: "planned" },
    ]);
    const result = await check();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Deleted module");
    // Counted so it is discoverable, not listed so it does not nag.
    expect(result.stderr).toContain("1 planned");
    expect(result.stderr).not.toContain("Session store");
  });

  it("says nothing about an external box, which is not the same as a missing ref", async () => {
    /*
     * The ref is load-bearing and used to be absent. A box with no ref is
     * skipped whatever its state, so this passed identically with the `external`
     * excuse removed from the engine -- it asserted nothing about the thing it
     * is named after. Caught by mutation, not by the suite.
     *
     * Pointing it at a file that does not exist is what makes the excuse the
     * only reason for silence: without it this is a plain missing-file finding.
     */
    await stateBoard([
      { id: "browser", label: "Browser canvas", ref: "src/browser.ts", state: "external" },
    ]);
    const result = await check();
    expect(findings(result.stderr)).toBe("");
    expect(result.code).toBe(0);
  });
});

/**
 * The removed-box check, against real git.
 *
 * The engine tests inject a baseline, so nothing there exercises git itself. What
 * is covered here is the part that decides whether this check is liveable: that
 * committing the diagram is what silences it, and that a project without git is
 * not broken by it.
 */
describe("check-drift and a box that was removed", () => {
  let project: string;

  function git(...args: string[]) {
    execFileSync("git", args, {
      cwd: project,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  }

  async function writeBoardWith(ids: string[]) {
    const made = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: ids.map((id) => ({ id, label: id.toUpperCase(), ref: `src/${id}.ts` })),
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/arch.excalidraw"), made.board);
  }

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeEach(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-deleted-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/layout.ts"), "export const layout = 1;\n");
    writeFileSync(path.join(project, "src/convert.ts"), "export const convert = 2;\n");
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  /** A committed board with both boxes, then the working copy loses one. */
  async function commitBothThenRemoveLayout() {
    git("init", "-q");
    await writeBoardWith(["layout", "convert"]);
    git("add", "-A");
    git("commit", "-qm", "board");
    await writeBoardWith(["convert"]);
  }

  it("reports the removed box while the deletion is uncommitted", async () => {
    await commitBothThenRemoveLayout();
    const result = await check();
    expect(result.stderr).toContain("LAYOUT");
    expect(result.stderr).toContain("src/layout.ts");
    expect(result.stderr).toContain("1 removed");
    expect(result.code).toBe(1);
  });

  it("goes quiet once the deletion is committed", async () => {
    // The mute, and the reason this check needs no switch of its own: committing
    // the diagram is the act that says the removal was deliberate.
    await commitBothThenRemoveLayout();
    expect((await check()).code).toBe(1);
    git("add", "-A");
    git("commit", "-qm", "drop the layout box");
    const after = await check();
    expect(findings(after.stderr)).toBe("");
    expect(after.code).toBe(0);
  });

  it("says nothing when the code was removed along with the box", async () => {
    await commitBothThenRemoveLayout();
    rmSync(path.join(project, "src/layout.ts"));
    const result = await check();
    expect(findings(result.stderr)).toBe("");
    expect(result.code).toBe(0);
  });

  it("says nothing in a project with no git at all", async () => {
    // A repository without git is not a broken one. Silence, never an error.
    await writeBoardWith(["convert"]);
    const result = await check();
    expect(findings(result.stderr)).toBe("");
    expect(result.code).toBe(0);
  });

  it("can be switched off without losing the other checks", async () => {
    await commitBothThenRemoveLayout();
    // Also break something the ordinary check owns, to prove only one went quiet.
    rmSync(path.join(project, "src/convert.ts"));
    const result = await check("--no-deletions");
    expect(result.stderr).not.toContain("removed");
    expect(result.stderr).toContain("CONVERT");
    expect(result.code).toBe(1);
  });
});

/**
 * Good news through the hook (#67), against real git.
 *
 * Bad news always reached the notice; a board that *improved* — a box added, a
 * box Claude flipped to built by redrawing — said nothing unless the hook made
 * the edit itself. What is pinned here is the whole liveability contract: the
 * improvement is announced, announced once rather than every turn until the
 * commit, and never twice when the hook's own promotion already has a line.
 */
describe("check-drift and a board that improved", () => {
  let project: string;

  function git(...args: string[]) {
    execFileSync("git", args, {
      cwd: project,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  }

  async function writeBoardWith(nodes: Array<{ id: string; state?: "planned" | "built" }>) {
    const made = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: nodes.map(({ id, state }) => ({
        id,
        label: id.toUpperCase(),
        ref: `src/${id}.ts`,
        ...(state ? { state } : {}),
      })),
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/arch.excalidraw"), made.board);
  }

  /** The hook's systemMessage, or "" when the run stayed silent. */
  async function hookMessage(): Promise<string> {
    const { stdout } = await run(TSX, [SCRIPT, "--hook"], { cwd: project });
    if (!stdout.trim()) return "";
    return (JSON.parse(stdout) as { systemMessage: string }).systemMessage;
  }

  beforeEach(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-goodnews-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/core.ts"), "export const core = 1;\n");
    git("init", "-q");
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("announces a box Claude flipped to built, then never repeats it", async () => {
    // Committed: the box is a plan. Then the code lands AND Claude redraws the
    // board to built in the same turn — the case where the hook used to find
    // nothing to promote and therefore said nothing.
    await writeBoardWith([{ id: "core" }, { id: "feature", state: "planned" }]);
    git("add", "-A");
    git("commit", "-qm", "plan");
    writeFileSync(path.join(project, "src/feature.ts"), "export const feature = 1;\n");
    await writeBoardWith([{ id: "core" }, { id: "feature", state: "built" }]);

    const first = await hookMessage();
    expect(first).toContain("arch.excalidraw improved");
    expect(first).toContain("1 built");

    // The board stays uncommitted, so the same comparison holds next turn —
    // and a notice repeating good news every turn is one somebody turns off.
    expect(await hookMessage()).toBe("");
  });

  it("announces an added box once, while the plan itself stays out of the alarm", async () => {
    await writeBoardWith([{ id: "core" }]);
    git("add", "-A");
    git("commit", "-qm", "board");
    await writeBoardWith([{ id: "core" }, { id: "next", state: "planned" }]);

    const first = await hookMessage();
    expect(first).toContain("+1 box");
    // The new box is planned and unbuilt — a work item, not a finding.
    expect(first).not.toContain("NEXT →");
    expect(await hookMessage()).toBe("");
  });

  it("does not also call the hook's own promotion an improvement", async () => {
    // Committed as planned, then only the code lands: the hook itself promotes.
    await writeBoardWith([{ id: "core" }, { id: "feature", state: "planned" }]);
    git("add", "-A");
    git("commit", "-qm", "plan");
    writeFileSync(path.join(project, "src/feature.ts"), "export const feature = 1;\n");

    const first = await hookMessage();
    expect(first).toContain("board updated");
    expect(first).not.toContain("improved");
    // Next turn the board says built and the committed one still says planned.
    // That flip was already announced as a promotion; it must not come back as news.
    expect(await hookMessage()).toBe("");
  });

  it("goes back to fresh ears once the improvement is committed", async () => {
    await writeBoardWith([{ id: "core" }]);
    git("add", "-A");
    git("commit", "-qm", "board");
    await writeBoardWith([{ id: "core" }, { id: "next", state: "planned" }]);
    expect(await hookMessage()).toContain("+1 box");

    // Committing is what makes news old: the memory clears with it, so the
    // *next* improvement after this one is announced from scratch.
    git("add", "-A");
    git("commit", "-qm", "keep the new box");
    expect(await hookMessage()).toBe("");
    await writeBoardWith([{ id: "core" }, { id: "next", state: "planned" }, { id: "later", state: "planned" }]);
    expect(await hookMessage()).toContain("+1 box");
  });

  it("stays silent in a project with no git", async () => {
    // No comparison point is silence, never an error.
    rmSync(path.join(project, ".git"), { recursive: true, force: true });
    await writeBoardWith([{ id: "core" }]);
    expect(await hookMessage()).toBe("");
  });
});

/**
 * Coverage on the command line. The engine decides what to suggest; what matters
 * here is that it never happens on its own — this is the one check that proposes
 * additions, and the per-turn notice is the thing it must stay out of.
 */
describe("check-drift and code the diagram does not show", () => {
  let project: string;

  async function setup() {
    project = mkdtempSync(path.join(tmpdir(), "drift-cov-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/a.ts"), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(path.join(project, "src/b.ts"), "export const b = 1;\n");
    const made = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "a", label: "A", ref: "src/a.ts" }],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/arch.excalidraw"), made.board);
  }

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeEach(setup);
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("never suggests anything unless asked", async () => {
    // The board is clean and omits src/b.ts. Saying so every turn is how a check
    // that nags gets switched off, taking the quiet ones with it.
    const result = await check();
    expect(findings(result.stderr)).toBe("");
    expect(result.code).toBe(0);
  });

  it("suggests the missing module with --coverage, and still exits clean", async () => {
    const result = await check("--coverage");
    expect(result.stderr).toContain("src/b.ts");
    expect(result.stderr).toContain("not shown");
    expect(result.stderr).toContain("suggestions, not drift");
    // A suggestion must never fail a build.
    expect(result.code).toBe(0);
  });

  it("keeps suggestions apart from real drift in the same run", async () => {
    // A second box pointing at nothing, while src/a.ts stays -- otherwise there
    // is no neighbourhood left to scan and the suggestion disappears with it.
    const made = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "gone", label: "Gone", ref: "src/gone.ts" },
      ],
      edges: [],
    });
    await writeBoard(path.join(project, "docs/diagrams/arch.excalidraw"), made.board);

    const result = await check("--coverage");
    // The broken claim sets the exit code; the suggestion rides along beside it,
    // in its own box, so neither is mistaken for the other.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Gone");
    expect(result.stderr).toContain("suggestions, not drift");
    expect(result.stderr).toContain("src/b.ts");
  });
});

/**
 * The audit: what was read, and what was not.
 *
 * The failure this closes is subtle and was hit three times in one session — a
 * silent run means either "everything agreed" or "there was nothing here I could
 * read", and the output was identical. These pin the difference, and pin that it
 * only ever appears when asked for.
 */
describe("check-drift saying what it did not look at", () => {
  let project: string;

  async function put(name: string, nodes: Array<{ id: string; label: string; ref?: string }>, edges: Array<{ from: string; to: string }> = []) {
    const made = await createDiagram(emptyBoard(), { name: "arch", nodes, edges });
    await writeBoard(path.join(project, `docs/diagrams/${name}.excalidraw`), made.board);
  }

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-audit-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/a.ts"), "export const a = 1;\n");
  });

  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("stays silent on a board it could not read anything on, unless asked", async () => {
    // Nothing here is checkable. The per-turn notice must still say nothing.
    await put("sketch", [{ id: "x", label: "Auth" }, { id: "y", label: "Queue" }], [{ from: "x", to: "y" }]);
    const quiet = await check();
    expect(findings(quiet.stderr)).toBe("");
    expect(quiet.code).toBe(0);
  });

  it("admits how little it read when asked", async () => {
    await put("sketch", [{ id: "x", label: "Auth" }, { id: "y", label: "Queue" }], [{ from: "x", to: "y" }]);
    const asked = await check("--details");
    // Not "0 boxes checked", which reads as a pass: the shared words say there
    // was nothing here to read.
    expect(asked.stderr).toContain("nothing here points at code yet");
    expect(asked.stderr).toContain("2 boxes skipped");
    expect(asked.stderr).toContain("no ref");
    expect(asked.stderr).toContain("1 arrows skipped");
    // The line that makes the distinction, spelled out rather than implied.
    expect(asked.stderr).toContain("silence means these agreed");
    expect(asked.code).toBe(0);
  });

  it("says so plainly when a board really was fully checked", async () => {
    // The other half: a clean board that was genuinely read should not read the
    // same as one that could not be.
    await put("real", [{ id: "a", label: "A", ref: "src/a.ts" }]);
    const asked = await check("--details");
    // The live board's chip says this in exactly these words.
    expect(asked.stderr).toContain("checked 1 box and 0 arrows");
    expect(asked.stderr).toContain("everything on this board was checked");
    expect(asked.stderr).not.toContain("boxes skipped");
  });

  it("names the reason an arrow went unread, per reason", async () => {
    await put("mixed", [
      { id: "a", label: "A", ref: "src/a.ts" },
      { id: "b", label: "B" },
    ], [{ from: "a", to: "b" }]);
    const asked = await check("--details");
    expect(asked.stderr).toContain("an end has no ref");
  });
});

/**
 * Anchor forms and the concept migration, end to end.
 *
 * The engine covers each form. What is covered here is the pair of things a
 * person actually sees: that a wide glob is refused rather than quietly
 * searching, and that marking a board concept changes "nobody annotated this"
 * into "this was never about your code".
 */
describe("check-drift and what a box is allowed to say", () => {
  let project: string;

  async function put(name: string, params: Parameters<typeof createDiagram>[1]) {
    const made = await createDiagram(emptyBoard(), params);
    await writeBoard(path.join(project, `docs/diagrams/${name}.excalidraw`), made.board);
  }

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "drift-anchors-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src/engine"), { recursive: true });
    writeFileSync(path.join(project, "src/engine/layout.ts"), "export const layout = 1;\n");
  });

  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("accepts a directory and a glob over one directory", async () => {
    await put("ok", {
      name: "arch",
      nodes: [
        { id: "d", label: "Engine", ref: "src/engine/" },
        { id: "g", label: "Engine files", ref: "src/engine/*.ts" },
      ],
      edges: [],
    });
    const result = await check();
    expect(findings(result.stderr)).toBe("");
    expect(result.code).toBe(0);
  });

  it("refuses a glob that would search the tree, and says why", async () => {
    await put("wide", {
      name: "arch",
      nodes: [{ id: "w", label: "Everything", ref: "src/**/*.ts" }],
      edges: [],
    });
    const result = await check();
    expect(result.code).toBe(1);
    // The notice names the box and the ref, never the reason — that is a
    // deliberate old decision, since a sentence repeated every turn is noise.
    // The reason rides on the finding, for check_drift's callers.
    expect(result.stderr).toContain("Everything");
    expect(result.stderr).toContain("src/**/*.ts");
  });

  it("reports a glob that matches nothing", async () => {
    await put("rust", {
      name: "arch",
      nodes: [{ id: "r", label: "Rust bits", ref: "src/engine/*.rs" }],
      edges: [],
    });
    expect((await check()).code).toBe(1);
  });

  it("turns unannotated boxes into excused ones when the board says concept", async () => {
    await put("proto", {
      name: "arch",
      title: "A protocol",
      describes: "concept",
      nodes: [{ id: "a", label: "S-CSCF" }, { id: "b", label: "P-CSCF" }],
      edges: [{ from: "a", to: "b" }],
    });
    const details = await check("--details");
    // The distinction the migration exists to make: not a gap to fill.
    expect(details.stderr).toContain("concept board");
    expect(details.stderr).toContain("outside this repo by declaration");
    expect(details.stderr).not.toContain("boxes skipped");
  });
});

/**
 * Promotions applied from the hook, and only from the hook.
 *
 * The per-turn path advances the board when a planned box's code lands: that is
 * the loop closing, and the notice says so once instead of repeating "is built
 * now" forever. The bare command stays a check -- a check that mutates the
 * working tree breaks every `git diff --exit-code` that runs after it in CI.
 */
describe("promotion from the hook", () => {
  let project: string;
  const boardPath = () => path.join(project, "docs/diagrams/plan.excalidraw");

  async function check(...args: string[]) {
    try {
      const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], { cwd: project });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  /** A planned box whose code already landed: one promotion waiting. */
  async function plantPromotion() {
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "plan",
      nodes: [{ id: "auth", label: "Auth service", ref: "src/auth.ts", state: "planned" }],
      edges: [],
    });
    await writeBoard(boardPath(), drawn);
    writeFileSync(path.join(project, "src/auth.ts"), "export const auth = true;\n");
  }

  function plannedShape(): { strokeStyle?: string; customData?: Record<string, unknown> } {
    const file = JSON.parse(readFileSync(boardPath(), "utf8")) as {
      elements: Array<{ type: string; strokeStyle?: string; customData?: Record<string, unknown> }>;
    };
    return file.elements.find(
      (element) => (element.customData as { node?: string } | undefined)?.node === "auth",
    )!;
  }

  beforeEach(async () => {
    project = mkdtempSync(path.join(tmpdir(), "drift-cli-promote-"));
    mkdirSync(path.join(project, "docs/diagrams"), { recursive: true });
    mkdirSync(path.join(project, "src"), { recursive: true });
    await plantPromotion();
  });

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it("advances the board, says so once, and is quiet the next turn", async () => {
    const first = await check("--hook");
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout) as { systemMessage: string };
    expect(payload.systemMessage).toContain("promoted");
    expect(payload.systemMessage).toContain("board updated");

    // The file itself was advanced to what regenerating it as built would write.
    const shape = plannedShape();
    expect(shape.strokeStyle).toBe("solid");
    expect(shape.customData).not.toHaveProperty("state");

    // The loop is closed: nothing left to repeat.
    const second = await check("--hook");
    expect(`${second.stdout}${second.stderr}`.trim()).toBe("");
  }, 120_000);

  it("leaves the file alone when it is not a hook", async () => {
    const result = await check();
    // Still reported -- as news, not as an action taken.
    expect(result.stderr).toContain("built");
    expect(result.stderr).not.toContain("promoted");
    const shape = plannedShape();
    expect(shape.strokeStyle).toBe("dashed");
    expect(shape.customData).toMatchObject({ state: "planned" });
  }, 120_000);

  /** A planned `@needs` arrow whose connection already landed. */
  async function plantClaimedPromotion(claim?: "needs") {
    const { board: drawn } = await createDiagram(emptyBoard(), {
      name: "plan",
      nodes: [
        { id: "a", label: "Reader", ref: "src/a.ts" },
        { id: "b", label: "Store", ref: "src/b.ts" },
      ],
      edges: [{ from: "a", to: "b", state: "planned", ...(claim ? { claim } : {}) }],
    });
    await writeBoard(boardPath(), drawn);
    writeFileSync(path.join(project, "src/a.ts"), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(path.join(project, "src/b.ts"), "export const b = 2;\n");
  }

  /*
   * The promotion of a claimed arrow is the run that makes the claim answerable
   * for the first time, and the answer -- including "drawn backwards" -- comes
   * on the run after (#123). Without a word here the pair reads as the tool
   * changing its mind about the same arrow one turn apart.
   */
  it("says a promoted @needs has not been read yet", async () => {
    await plantClaimedPromotion("needs");
    const result = await check("--hook");
    const said = JSON.parse(result.stdout) as { systemMessage: string };
    expect(said.systemMessage).toContain("board updated");
    expect(said.systemMessage).toContain("a promoted @needs is read for the first time");
  }, 120_000);

  it("keeps quiet about claims when the promoted arrow carried none", async () => {
    await plantClaimedPromotion();
    const result = await check("--hook");
    const said = JSON.parse(result.stdout) as { systemMessage: string };
    expect(said.systemMessage).toContain("board updated");
    expect(said.systemMessage).not.toContain("@needs");
  }, 120_000);
});
