/**
 * Print what the dependency reader finds, against what the regex channel finds.
 *
 *   npm run measure:deps
 *
 * Two readers over the same files. The regex channel in `drift.ts` is what has
 * always corroborated arrows; `deps.ts` parses the grammar instead. The
 * difference is printed in both directions, because the two directions mean
 * opposite things:
 *
 * - **only the regex found it** -- either a file the reader has no grammar for,
 *   or a specifier the regex invented out of ordinary source text.
 * - **only the reader found it** -- a dependency the confirming channel has been
 *   blind to. There should be none while the reader is TypeScript only.
 *
 * The measuring lives in `scripts/lib/deps-measure.mts` so the test asserts on
 * the same numbers this prints, rather than on a second implementation of them.
 * What this prints is what step 3 turns into a committed licence; until then it
 * is a thing you run, not a thing anyone claims.
 */
import { measureDependencies } from "./lib/deps-measure";

const measured = await measureDependencies(process.argv[2] ?? process.cwd());
const readable = measured.files.length - measured.noGrammar.length;

console.log(`root                 ${measured.root}`);
console.log(`files walked         ${measured.files.length}`);
console.log(`no grammar           ${measured.noGrammar.length}`);
console.log(`regex channel found  ${measured.fromRegex.size}`);
console.log(`reader found         ${measured.fromReader.size}`);
console.log(`only the regex       ${measured.onlyRegex.length}`);
for (const edge of measured.onlyRegex) console.log(`   regex only   ${edge}`);
console.log(`only the reader      ${measured.onlyReader.length}`);
for (const edge of measured.onlyReader) console.log(`   reader only  ${edge}`);
console.log(
  `\nnot completely read  ${measured.incomplete.length}`
  + `${measured.incomplete.length ? `: ${measured.incomplete.join(", ")}` : ""}`,
);
console.log(
  `escapes statically   ${measured.dynamic.length} of ${readable} `
  + `(${Math.round((measured.dynamic.length / Math.max(1, readable)) * 100)}%)`,
);
for (const { file, reasons } of measured.dynamic) console.log(`   ${file}  ${reasons.join(", ")}`);
