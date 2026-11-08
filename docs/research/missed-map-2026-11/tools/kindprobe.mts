// kindprobe.mts: for each missed wrong-kind arrow, the text-only part reading of the end the key calls the wrong kind.
import path from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
const REPO = "/Users/noelmatero/board-ai-map2";
const { initEngine, languageOf } = await import(path.join(REPO, "src/engine/parse.ts"));
const { partsOf, NEEDS } = await import(path.join(REPO, "src/engine/parts.ts"));
await initEngine();
const ROOT: Record<string, string> = { main: "/Users/noelmatero/board-ai/.corpus", holdout: "/Users/noelmatero/.board-ai-holdout/corpus", "holdout-b": "/Users/noelmatero/.board-ai-holdout-b/corpus" };
const rows = JSON.parse(readFileSync("/Users/noelmatero/bench-map2/analysis/missed-all.json", "utf8")).filter((r: any) => r.family === "wrong kind of end");
const out: any[] = [];
for (const r of rows) {
  const end = /the from end/.test(r.why) ? "from" : "to";
  const ref: string = r[end];
  const [file, sym] = ref.split("#");
  const part = NEEDS[r.word][end];
  const p = path.join(ROOT[r.set], r.project, file);
  let reading = "no-file";
  const names = sym ? [sym, sym.split(/\.|::/).pop()!] : [];
  if (existsSync(p) && sym) {
    const src = readFileSync(p, "utf8");
    const lang = languageOf(p);
    const got = names.map((n) => partsOf(src, n, lang)).find(Boolean);
    reading = got ? String(got[part]) : "name-not-found";
  }
  out.push({ set: r.set, id: r.id, lang: r.lang, word: r.word, end, part, reading, reason: r.reason, ref });
}
writeFileSync("/Users/noelmatero/bench-map2/analysis/kindprobe.json", JSON.stringify(out, null, 0));
const c = new Map<string, number>();
for (const o of out) { const k = `${o.word} ${o.end}:${o.part} -> ${o.reading}`; c.set(k, (c.get(k) ?? 0) + 1); }
for (const [k, n] of [...c].sort((a, b) => b[1] - a[1])) console.log(n, k);
