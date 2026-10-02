/**
 * One check, run in a process of its own so a test can kill it (#407).
 *
 * A walk that goes round for ever is a synchronous loop: it never yields, so
 * vitest's own timeout never fires and the whole worker hangs with it. Run
 * here instead, under `spawnSync`'s timeout, a hang is a failed test.
 *
 * Reads one JSON question on stdin and prints one JSON answer:
 *
 *   { "files": {...}, "board": "src/rec.ts#a" }
 *     -- a board of two boxes on that ref and a `calls` arrow between them,
 *        checked the way `check_drift` checks it with no compiler; answers
 *        `{ edges: [[kind, detail]], calls, confirmed }`.
 *   { "files": {...}, "reach": ["src/rec.ts", "a"] }
 *     -- `reachBetween` from that routine to itself; answers its verdict.
 */
import { emptyBoard } from "../../src/engine/board-file";
import { createDiagram } from "../../src/engine/diagram";
import { checkDrift, type Workspace } from "../../src/engine/drift";
import { initEngine, languageOf, type Language } from "../../src/engine/parse";
import { reachBetween } from "../../src/engine/reach";
import { installExcalifontMeasurer } from "./excalifont";

interface Question {
  files: Record<string, string>;
  board?: string;
  reach?: [file: string, routine: string];
}

function memory(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

async function answer(question: Question): Promise<unknown> {
  const { files } = question;
  if (question.reach) {
    const [file, routine] = question.reach;
    const side = { file, source: files[file]!, language: languageOf(file)! as Language, imports: [] };
    return reachBetween({ ...side, routine }, { ...side, names: [routine] });
  }
  const ref = question.board!;
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [{ id: "caller", label: "caller", ref }, { id: "callee", label: "callee", ref }],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  const report = checkDrift(board, memory(files), { edges: true });
  return {
    edges: report.edges.map((finding) => [finding.kind, finding.detail]),
    calls: report.claims.calls,
    confirmed: report.claims.callsConfirmed,
  };
}

installExcalifontMeasurer();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  void (async () => {
    await initEngine();
    process.stdout.write(JSON.stringify(await answer(JSON.parse(input) as Question)));
    process.exit(0);
  })();
});
