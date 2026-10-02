/**
 * Every probe #373 drew, checked the way the MCP server checks a board (#393).
 *
 * #373 drew 448 correct arrows and boxes over small repositories and 58 went
 * red. Each file in `fixtures/probes-373` is one of those repositories, drawn
 * as one board: every arrow on it is correct except the ones named
 * `CONTROL` or `PLANTED`, which are wrong on purpose and must stay red, so a
 * probe that went quiet cannot be mistaken for one that was checked.
 *
 * The correct arrows still red are listed below with the issue that owns
 * them. None is a shape a compiler question answers: how a board's text is
 * matched to code (#382, #385), and #360's decision that getting a value back
 * from a function is not making it.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type ClosedBodyReferee } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { hasRustAnalyzer } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

type Arrow = [shape: string, from: string, to: string, claim: string, label?: string];
interface Fixture { name: string; files: Record<string, string>; arrows: Arrow[]; boxes?: Array<[string, string, string[]]> }

/** Correct arrows and boxes still red, by `fixture|shape`, and the issue that owns each. */
const STILL_RED: Record<string, string> = {
  "builds|Py dataclasses.replace": "#360",
  "builds|Py copy.copy": "#360",
  "handles|Rs Some(Variant)/Some(_)/None": "#385",
};

/** Wrong-on-purpose arrows that were already quiet on main before #393: nothing here made them so. */
const QUIET_BEFORE = new Set([
  "js|CONTROL wrong: plain reads width",
  "py-routes|CONTROL wrong: keep_file does not call double",
  "targets|CONTROL wrong: test works calls nothing in main",
]);

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);
const FIXTURES = path.join(import.meta.dirname, "fixtures", "probes-373");
const names = readdirSync(FIXTURES).filter((file) => file.endsWith(".ts")).map((file) => file.slice(0, -3)).sort();

describe.each(names)("#373's %s probe", (name) => {
  it("calls no correct arrow wrong, and still calls every planted one wrong", async () => {
    const { fixture } = (await import(path.join(FIXTURES, `${name}.ts`))) as { fixture: Fixture };
    const root = mkdtempSync(path.join(tmpdir(), `probe-373-${name}-`));
    try {
      for (const [relative, text] of Object.entries(fixture.files)) {
        const full = path.join(root, relative);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
      const ids = new Map<string, string>();
      const idOf = (ref: string) => {
        if (!ids.has(ref)) ids.set(ref, `n${ids.size}`);
        return ids.get(ref)!;
      };
      for (const [, from, to] of fixture.arrows) { idOf(from); idOf(to); }
      const boxCases = new Map((fixture.boxes ?? []).map(([, ref, cases]) => [ref, cases]));
      for (const ref of boxCases.keys()) idOf(ref);
      const { board } = await createDiagram(emptyBoard(), {
        name: "probe",
        nodes: [...ids].map(([ref, id]) => ({
          id, label: ref.split("#").pop()!, ref, ...(boxCases.has(ref) ? { handles: boxCases.get(ref) } : {}),
        })),
        edges: fixture.arrows.map(([, from, to, claim, label]) => ({
          from: idOf(from), to: idOf(to), claim: claim as never, ...(label ? { label } : {}),
        })),
      });
      const workspace = createWorkspace(root);
      const { report } = await refereedCheckLive(root, (referee?: ClosedBodyReferee) =>
        checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));

      // How the #373 driver picked one arrow's findings out of a board with several on one pair.
      const redOf = ([, from, to, claim, label]: Arrow) => report.edges.some((one) =>
        one.fromRef === from && one.toRef === to && ACCUSES.has(one.kind)
        && (!label || String(one.detail).includes(`\`${label}\``))
        && (claim === "takes" ? !/return type of/.test(one.detail) : claim === "returns" ? !/parameters of/.test(one.detail) : true));
      const wrongly: string[] = [];
      const missed: string[] = [];
      for (const arrow of fixture.arrows) {
        const [shape, from, to] = arrow;
        const planted = /^(CONTROL|PLANTED)/.test(shape);
        const red = redOf(arrow);
        if (!planted && red && !STILL_RED[`${name}|${shape}`]) wrongly.push(shape);
        // A planted Rust arrow may need rust-analyzer to be caught, and CI has none.
        const needsRust = /\.rs(#|$)/.test(from) || /\.rs(#|$)/.test(to);
        if (planted && !red && !QUIET_BEFORE.has(`${name}|${shape}`) && (hasRustAnalyzer || !needsRust)) missed.push(shape);
      }
      for (const [shape, ref] of fixture.boxes ?? []) {
        const red = report.findings.some((one) => one.node === idOf(ref) && /mishandled|refuted|wrong/.test(one.kind));
        if (red && !STILL_RED[`${name}|${shape}`]) wrongly.push(shape);
      }
      expect({ wrongly, missed }).toEqual({ wrongly: [], missed: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
