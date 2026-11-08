// tailkind.mts: for every @calls arrow in the three study dumps, is each end a type (engine's isTypeName)?
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
const REPO = "/Users/noelmatero/board-ai-map2";
const { initEngine, languageOf } = await import(path.join(REPO, "src/engine/parse.ts"));
const { isTypeName } = await import(path.join(REPO, "src/engine/calls.ts"));
const { parseRef } = await import(path.join(REPO, "src/engine/drift.ts"));
await initEngine();
const CORPUS: Record<string, string> = { main: "/Users/noelmatero/board-ai/.corpus", holdout: `${os.homedir()}/.board-ai-holdout/corpus`, "holdout-b": `${os.homedir()}/.board-ai-holdout-b/corpus` };
const out: string[] = [];
for (const set of ["main", "holdout", "holdout-b"]) {
  readFileSync(`${os.homedir()}/bench-map2/score/${set}.jsonl`, "utf8").split("\n").filter(Boolean).forEach((line, i) => {
    const r = JSON.parse(line);
    if (!["calls","builds","accesses","feeds"].includes(r.word)) return;
    const kind = (ref: string) => {
      const { path: p, symbol } = parseRef(ref);
      if (!symbol) return "file";
      const f = path.join(CORPUS[set], r.project, p);
      if (!existsSync(f)) return "nofile";
      return isTypeName(readFileSync(f, "utf8"), symbol, languageOf(f)) ? "type" : "other";
    };
    out.push(JSON.stringify({ i: `${set}:${i}`, from: kind(r.from), to: kind(r.to) }));
  });
}
console.log(out.join("\n"));
