/**
 * The licence: what the reader had to learn before it could be believed.
 *
 * Every rule below is here because a measurement found it missing, not because
 * somebody thought of it. `scripts/lib/licence.ts` runs the TypeScript compiler
 * over a tree as an independent referee -- its own parser for the specifiers,
 * its own `resolveModuleName` for the files -- and each of these tests pins one
 * of the disagreements that turned up across five repositories and 12,824
 * dependency edges.
 *
 * The referee matters more than the rules. `deps.ts` and the regex channel in
 * `drift.ts` both hand their specifiers to `resolve.ts`, so their agreement was
 * never evidence about the step they share, which is exactly where the tsconfig
 * and package.json nicknames live. Measuring against the compiler is what turned
 * that blind spot into 121 named, fixable misses.
 *
 * The last block is the guard that keeps this true: the same harness over this
 * repository, failing on any disagreement at all.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";

import { readDependencies } from "../src/engine/deps";
import { createWorkspace, type Workspace } from "../src/engine/drift";
import { initEngine, type Language } from "../src/engine/parse";
import { resolveDependency } from "../src/engine/resolve";
import { ARROW_CLAIMS } from "../src/engine/claim";
import {
  ACCUSING_RELATIONS, LICENCES, isMeasured, licenceFor, licenceTotals, mayAccuse,
  relationLicence, relationTotals, type AccusingRelation,
} from "../src/engine/licence";
import { measureLicence } from "../scripts/lib/licence";

beforeAll(async () => {
  await initEngine();
}, 60_000);

function fakeWorkspace(files: Record<string, string>): Workspace {
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

/** Where a specifier written in `from` lands, given a tree. */
function lands(specifier: string, from: string, files: Record<string, string>): string | undefined {
  return resolveDependency(specifier, from, fakeWorkspace(files))?.rel;
}

describe("a type-only module is still a file", () => {
  it("resolves a specifier whose only match is a declaration", () => {
    // 119 of the 121 misses in the first measurement were this one shape:
    // `import { Foo } from "./utils"` where the only utils is `utils.d.ts`.
    expect(lands("./utils", "src/a.ts", { "src/a.ts": "", "src/utils.d.ts": "" })).toBe("src/utils.d.ts");
  });

  it("prefers the code to the declaration describing it", () => {
    // This repository's own `scripts/lib/box.mjs` ships a hand-written
    // `box.d.mts` beside it. A box on a board is the module, not its types.
    expect(
      lands("./box.mjs", "scripts/check.mjs", {
        "scripts/check.mjs": "",
        "scripts/box.mjs": "",
        "scripts/box.d.mts": "",
      }),
    ).toBe("scripts/box.mjs");
  });

  it("falls back to a declaration when the code is not there", () => {
    expect(lands("./box.mjs", "scripts/check.mjs", { "scripts/check.mjs": "", "scripts/box.d.mts": "" }))
      .toBe("scripts/box.d.mts");
  });

  it("maps a .cjs specifier onto the .cts that will build it", () => {
    expect(lands("./hello.cjs", "src/a.ts", { "src/a.ts": "", "src/hello.cts": "" })).toBe("src/hello.cts");
  });
});

describe("package.json nicknames", () => {
  const tree = {
    "package.json": JSON.stringify({
      imports: { "#types/*": "./types/*.d.ts", "#dep-types/*": "./src/types/*.d.ts" },
    }),
    "src/node/http.ts": "",
    "src/types/connect.d.ts": "",
    "types/hot.d.ts": "",
  };

  it("follows an imports wildcard to the file it names", () => {
    // 77 of vite's 84 remaining misses were `#dep-types/...` alone.
    expect(lands("#dep-types/connect", "src/node/http.ts", tree)).toBe("src/types/connect.d.ts");
    expect(lands("#types/hot", "src/node/http.ts", tree)).toBe("types/hot.d.ts");
  });

  it("takes the condition every reader shares, not the first one offered", () => {
    // vite offers "module-sync" before "default". Whether module-sync holds is
    // not in the text, so it is not a candidate; every compiler takes false.js.
    const conditional = {
      "package.json": JSON.stringify({
        imports: { "#flag": { "module-sync": "./misc/true.js", default: "./misc/false.js" } },
      }),
      "src/a.ts": "",
      "misc/true.js": "",
      "misc/false.js": "",
    };
    expect(lands("#flag", "src/a.ts", conditional)).toBe("misc/false.js");
  });

  it("still lets tsconfig claim a # nickname of its own", () => {
    // vite's resolver fixtures declare `"#/*": ["./src/*"]` in tsconfig paths.
    // Reserving `#` for Node outright lost that edge.
    expect(
      lands("#/imported", "src/hash.ts", {
        "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#/*": ["./src/*"] } } }),
        "src/hash.ts": "",
        "src/imported.js": "",
      }),
    ).toBe("src/imported.js");
  });
});

describe("a directory is not always an index file", () => {
  it("follows the entry its own package.json names", () => {
    expect(
      lands("./", "dep/entry.js", {
        "dep/entry.js": "",
        "dep/package.json": JSON.stringify({ main: "lib/main.js" }),
        "dep/lib/main.js": "",
      }),
    ).toBe("dep/lib/main.js");
  });

  it("still prefers index when nothing names an entry", () => {
    expect(lands("./lib", "dep/entry.js", { "dep/entry.js": "", "dep/lib/index.ts": "" }))
      .toBe("dep/lib/index.ts");
  });
});

describe("a package reaching for itself by name", () => {
  const own = {
    "pkg/package.json": JSON.stringify({
      name: "@scope/thing",
      exports: { ".": "./index.js", "./test": "./test/index.js" },
    }),
    "pkg/index.js": "",
    "pkg/test/index.js": "",
    "pkg/test/side.js": "",
  };

  it("resolves the bare name through its own exports", () => {
    expect(lands("@scope/thing", "pkg/test/side.js", own)).toBe("pkg/index.js");
  });

  it("resolves a subpath the exports map declares", () => {
    expect(lands("@scope/thing/test", "pkg/test/side.js", own)).toBe("pkg/test/index.js");
  });

  it("refuses the name when there is no exports field", () => {
    // Node's rule, and the reason it matters: without `exports` the import is
    // simply broken, and resolving it anyway asserts an edge no runtime has.
    const noExports = {
      "pkg/package.json": JSON.stringify({ name: "@scope/thing", main: "index.js" }),
      "pkg/index.js": "",
      "pkg/side.js": "",
    };
    expect(lands("@scope/thing", "pkg/side.js", noExports)).toBeUndefined();
  });

  it("leaves a genuinely third-party name alone", () => {
    expect(lands("@scope/other", "pkg/test/side.js", own)).toBeUndefined();
  });
});

describe("backticks", () => {
  const files = { "src/a.ts": "", "src/static.ts": "" };

  it("reads a template with nothing in it as the string it is", () => {
    const source = "import(`./static`).then(() => {});";
    const read = readDependencies("src/a.ts", source, fakeWorkspace({ ...files, "src/a.ts": source }))!;
    expect(read.dependencies.map((one) => one.file)).toEqual(["src/static.ts"]);
  });

  it("declines to guess at one with a value in it", () => {
    const source = "const n = 'static';\nimport(`./${n}`).then(() => {});";
    const read = readDependencies("src/a.ts", source, fakeWorkspace({ ...files, "src/a.ts": source }))!;
    expect(read.dependencies).toEqual([]);
    expect(read.dynamic).toContain("dynamic-import");
  });
});

describe("the licence on record", () => {
  const licence = LICENCES.find((one) => one.language === "typescript")!;

  it("pins every corpus entry to a commit", () => {
    expect(licence.corpus.length).toBeGreaterThan(0);
    for (const entry of licence.corpus) {
      expect(entry.commit, entry.name).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.url, entry.name).toMatch(/^https:\/\//);
    }
  });

  it("covers a file this tool would actually read", () => {
    expect(licenceFor("src/engine/drift.ts")?.language).toBe("typescript");
    expect(licenceFor("src/engine/board.rs")?.language).toBe("rust");
    expect(licenceFor("src/engine/board.py")?.language).toBe("python");
    expect(licenceFor("src/main.go")).toBeUndefined();
    expect(licenceFor("docs/notes.md")).toBeUndefined();
  });

  it("adds up to the numbers it claims", () => {
    const totals = licenceTotals(licence);
    expect(totals.edges).toBe(12824);
    expect(totals.missed).toBe(2);
    expect(totals.invented).toBe(1);
    expect(totals.recall).toBeGreaterThan(0.9998);
    expect(totals.precision).toBeGreaterThan(0.9999);
  });

  it("names the disagreements it does not expect to close", () => {
    // Two entries for three disagreements: vite's miss and its invention are the
    // same specifier in the same fixture, resolved two defensible ways.
    expect(licence.known.length).toBe(2);
  });
});

describe("the Python licence on record", () => {
  const licence = LICENCES.find((one) => one.language === "python")!;

  it("pins every corpus entry to a commit", () => {
    expect(licence.corpus.length).toBe(5);
    for (const entry of licence.corpus) {
      expect(entry.commit, entry.name).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.url, entry.name).toMatch(/^https:\/\//);
    }
  });

  it("adds up to the numbers it claims", () => {
    const totals = licenceTotals(licence);
    expect(totals.edges).toBe(12693);
    expect(totals.missed).toBe(41);
    // Nothing invented in 12,693 edges. That is the direction that matters: an
    // edge the reader makes up is an accusation resting on evidence nobody had.
    expect(totals.invented).toBe(0);
    expect(totals.recall).toBeGreaterThan(0.996);
    expect(totals.precision).toBe(1);
  });

  it("states the remainder rather than netting it off", () => {
    // pydantic excludes `pydantic/v1` from its own pyright config, so the
    // referee never bound those files and has no opinion to disagree with.
    const stated = licence.corpus.reduce((into, entry) => into + (entry.unmeasured ?? 0), 0);
    expect(stated).toBe(134);
  });

  it("names the disagreements it does not expect to close", () => {
    // Every one of the 41 misses is the first entry: a wildcard import followed
    // through a package's re-exports to modules the text never names.
    expect(licence.known.length).toBe(3);
  });
});

const LANGUAGES: Language[] = ["ts", "tsx", "js", "rust", "python"];

/**
 * The first markdown table under a heading in `docs/claim-vocabulary.md`, as
 * rows of trimmed cells with the emphasis markers taken off.
 *
 * Found by its heading rather than by its header row, because two tables in that
 * file start `| word |` and picking the wrong one is a test that passes for the
 * wrong reason.
 */
function tableUnder(heading: string | RegExp): string[][] {
  const doc = readFileSync(
    path.resolve(__dirname, "..", "docs", "claim-vocabulary.md"), "utf8",
  ).split("\n");
  const at = typeof heading === "string"
    ? doc.indexOf(heading)
    : doc.findIndex((line) => heading.test(line));
  expect(at, `docs/claim-vocabulary.md has no "${heading}"`).toBeGreaterThan(-1);
  const start = doc.findIndex((line, index) => index > at && line.startsWith("|"));
  expect(start, `no table under "${heading}"`).toBeGreaterThan(-1);

  const rows: string[][] = [];
  for (let line = start; line < doc.length && doc[line].startsWith("|"); line += 1) {
    if (doc[line].includes("---")) continue;
    rows.push(doc[line].split("|").slice(1, -1).map((cell) => cell.replaceAll("*", "").trim()));
  }
  return rows;
}

/** The word a `| \`@needs\` |` cell names. */
const wordIn = (cell: string): string => cell.replaceAll("`", "").replace("@", "");

describe("which words may accuse, and in which languages", () => {
  it("has a measurement behind every square that says yes", () => {
    /*
     * Exhaustive on both axes on purpose, and that is the whole of #207.
     *
     * Add a sixth `Language` to `parse.ts` or a seventh word to `ARROW_CLAIMS`
     * and this stops compiling, which is the moment somebody has to decide
     * whether it has been measured. The alternative -- a list that quietly
     * covers what it happens to cover -- is how one Python entry came to speak
     * for four words on the strength of three unrelated runs.
     *
     * Both blocks of `false` are findings rather than design, and neither was
     * visible before the squares had to be filled in one at a time.
     *
     * `builds` has never been measured in Python: `measure:constructs` asks it 0
     * times over 442 files, because Python spells making one of something as an
     * ordinary call.
     *
     * JavaScript has never been measured for any of the four words the
     * dependency corpus does not cover. It sits inside the TypeScript licence,
     * and that licence's imports were measured over five repositories -- but
     * `measure:holds`, `measure:signature` and `measure:constructs` ask it 0
     * questions between them, and `measure:calls` asks it 2. Until this grid
     * existed all five squares read `yes`, on TypeScript's numbers.
     *
     * `calls` is the one that arrived after the grid was written and before it
     * had landed, which is the whole argument for the grid rather than an
     * illustration of it: #211 shipped a refutable word reading the old
     * per-language gate, so a JavaScript arrow was refutable on 2 asks. Nothing
     * structural stopped it the way `no-fields` stops a JavaScript `holds`.
     */
    const grid: Record<AccusingRelation, Record<Language, boolean>> = {
      needs: { ts: true, tsx: true, js: true, rust: true, python: true },
      takes: { ts: true, tsx: true, js: false, rust: true, python: true },
      returns: { ts: true, tsx: true, js: false, rust: true, python: true },
      holds: { ts: true, tsx: true, js: false, rust: true, python: true },
      builds: { ts: true, tsx: true, js: false, rust: true, python: false },
      calls: { ts: true, tsx: true, js: false, rust: true, python: true },
    };
    for (const relation of ACCUSING_RELATIONS) {
      for (const language of LANGUAGES) {
        expect(mayAccuse(relation, language), `${relation} in ${language}`)
          .toBe(grid[relation][language]);
      }
    }
  });

  it("stays silent about a word nobody has measured anywhere", () => {
    /*
     * The shape that matters, stated as a test: an *unlisted* pair must answer
     * "may not accuse", never "may". `handles` is #206's word and has no reader
     * yet, so it stands in for whatever arrives next -- and the point is that it
     * inherits nothing from the four measurements Python already has.
     *
     * `invokes` stood here until #189 shipped it as `calls`, and what happened
     * in between is why the cast matters: the word arrived, the type made the
     * hole visible in four places, and every one of them had to be answered by
     * hand. The cast is the other half -- a word that routes around the type
     * still gets a no.
     */
    const next = "handles" as AccusingRelation;
    for (const language of LANGUAGES) {
      expect(mayAccuse(next, language), language).toBe(false);
      expect(relationLicence(next, language), language).toBeUndefined();
    }
  });

  it("asks about every word that can accuse, and only those", () => {
    // Filtered from `ARROW_CLAIMS` rather than typed out, so a report that walks
    // it cannot quietly stop mentioning a word.
    expect([...ACCUSING_RELATIONS]).toEqual(ARROW_CLAIMS.filter((word) => word !== "feeds"));
  });

  it("gives a reason where it says no, rather than a shrug", () => {
    const row = relationLicence("builds", "python");
    expect(row).toBeDefined();
    expect(row && isMeasured(row)).toBe(false);
    expect(row && !isMeasured(row) ? row.unmeasured : "").toMatch(/ordinary call/);
  });

  it("leaves no square empty, whatever the type is doing", () => {
    // The type already makes this impossible. Asserted anyway, because the
    // guard that only the compiler enforces is the one a cast walks past.
    for (const licence of LICENCES) {
      for (const relation of ACCUSING_RELATIONS) {
        expect(licence.relations[relation], `${licence.language}.${relation}`).toBeDefined();
      }
    }
  });

  it("reads the `needs` numbers off the corpus rather than a second copy", () => {
    // Two lists of one fact drift, and the one that drifts silently is the one
    // nothing reads. So the row cites the table above instead of restating it.
    const python = LICENCES.find((one) => one.language === "python")!;
    const corpus = licenceTotals(python);
    expect(relationTotals("needs", "python")).toEqual({
      asked: corpus.edges, missed: corpus.missed, invented: corpus.invented,
    });
    expect(corpus.edges).toBe(12693);
  });

  it("keeps a miss of zero, or names every miss it keeps", () => {
    /*
     * The bar, in one place, and it is not the same bar everywhere.
     *
     * `holds`, `takes`, `returns` and `builds` are measured against a text scan
     * of the same declarations over trees taken as they sit on disk, and there
     * the bar is zero: a miss is the referee seeing a name the reader did not,
     * and a miss paired with a hit the other way is a false red.
     *
     * `needs` is the exception and it is deliberate. Its referee is a real
     * compiler over five pinned repositories, and its 48 misses across three
     * languages are all understood -- they are the `known` list on each licence,
     * every one of them a place where the reader and the referee mean different
     * things by an edge. A zero there would mean the corpus was too small.
     *
     * `rust`'s `calls` row is the case that made that distinction structural
     * rather than a sentence in this comment. Measured on the trees to hand it
     * asks 36 questions and misses none, which is the too-small zero the
     * paragraph above warns about; measured over the two repositories the
     * dependency corpus already pins it asks 574 and misses 4. So the rule is
     * the one `needs` always had: a miss is allowed when somebody has read it
     * and written down what it is, and `known` is where that goes.
     *
     * The count is checked rather than the prose, so a fifth miss cannot hide
     * behind four explanations -- and `known` may not be carried by a row with
     * nothing to explain, so it cannot rot into decoration either.
     */
    for (const relation of ACCUSING_RELATIONS) {
      for (const language of LANGUAGES) {
        const row = relationLicence(relation, language);
        if (!row || !isMeasured(row) || row.counts === "corpus") continue;
        const where = `${relation} in ${language}`;
        if (row.counts.missed === 0) {
          expect(row.known, `${where} explains misses it does not have`).toBeUndefined();
          continue;
        }
        expect(row.known ?? [], `${where} misses ${row.counts.missed} and says why`)
          .not.toHaveLength(0);
      }
    }
  });

  it("says what the dependency corpus misses instead of pretending it does not", () => {
    // The other side of the rule above: `needs` has misses, they are counted,
    // and each licence names the shapes they are.
    for (const licence of LICENCES) {
      const totals = licenceTotals(licence);
      expect(totals.missed, licence.language).toBeGreaterThan(0);
      expect(licence.known.length, licence.language).toBeGreaterThan(0);
    }
  });

  it("says the same thing in the doc as it does in the code", () => {
    /*
     * The grid is written twice: once as data in `licence.ts`, once as a table
     * in `docs/claim-vocabulary.md` for somebody reading rather than running.
     * Two lists of one fact drift, and the one that drifts silently is the one
     * nothing reads -- which this file says about the engine and was true of
     * its own documentation until this test existed.
     *
     * The doc stays hand-written, because it carries prose the data cannot. The
     * table inside it does not get to disagree.
     *
     * A column nothing recognises fails rather than being skipped: adding a
     * language to that table has to be a decision, the same way adding one to
     * `parse.ts` is.
     */
    const columns: Record<string, readonly Language[]> = {
      "TS / TSX": ["ts", "tsx"],
      JavaScript: ["js"],
      Rust: ["rust"],
      Python: ["python"],
    };

    const [header, ...rows] = tableUnder("### The grid");

    // Every word, in the order the code lists them: a new one has to reach the
    // table too, not just the type.
    expect(rows.map((row) => wordIn(row[0]))).toEqual([...ACCUSING_RELATIONS]);

    for (const [column, title] of header.entries()) {
      // First column is the word, last is prose about the referee.
      if (column === 0 || column === header.length - 1) continue;
      const languages = columns[title];
      expect(languages, `unknown column "${title}" in the doc's grid`).toBeDefined();
      for (const row of rows) {
        const relation = wordIn(row[0]) as AccusingRelation;
        const said = row[column];
        expect(said, `${relation} / ${title}`).toMatch(/^(yes|no)$/);
        for (const language of languages) {
          expect(mayAccuse(relation, language), `${relation} in ${language}, per the doc`)
            .toBe(said === "yes");
        }
      }
    }
  });

  it("agrees with the vocabulary table about which words accuse at all", () => {
    /*
     * The other table in the same document, and the same drift risk. Its "may
     * say wrong" column is the list `ACCUSING_RELATIONS` is: a word that never
     * accuses needs no licence, and one that does needs a row in every one.
     *
     * Matched on the stable half of the heading, because the count in it moves
     * every time a word ships -- it said "six" until #189 made it seven -- and a
     * test that breaks on the *title* of the section it is checking teaches
     * whoever adds the eighth word to edit the test rather than read it.
     */
    const [header, ...rows] = tableUnder(/^## The \w+ words, and the three footings$/);
    const column = header.indexOf("may say wrong");
    expect(column, "the vocabulary table lost its `may say wrong` column").toBeGreaterThan(-1);
    const accusing = rows.filter((row) => row[column] === "yes").map((row) => wordIn(row[0]));
    expect(accusing).toEqual([...ACCUSING_RELATIONS]);
  });

  it("says nothing about a language nobody measured", () => {
    // The licence is a measurement, not a list of languages somebody liked.
    expect(licenceFor("src/main.go")).toBeUndefined();
    expect(licenceFor("src/Main.java")).toBeUndefined();
  });
});

describe("the compiler over this repository", () => {
  let measured: Awaited<ReturnType<typeof measureLicence>>;

  beforeAll(async () => {
    measured = await measureLicence(path.resolve(__dirname, ".."));
  }, 120_000);

  it("agrees with the reader on every dependency, both ways", () => {
    // Not a count, which would rot on the next commit -- a disagreement of zero,
    // which is the thing the licence actually claims.
    expect(measured.missed).toEqual([]);
    expect(measured.invented).toEqual([]);
    expect(measured.refereeEdges.size).toBeGreaterThan(200);
  });

  it("has a grammar for every source file it looked at", () => {
    // A silence by design is fine; a silence nobody noticed is how a licence
    // ends up covering less than it says.
    expect(measured.skipped).toEqual([]);
  });
});
