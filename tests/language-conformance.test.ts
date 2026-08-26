/**
 * The same claims, the same damage, every language.
 *
 * Everything else here is measured against one Rust file and hand-written
 * TypeScript snippets. That leaves two gaps: nothing pins what a *supported*
 * language must do, so a regression in one shows up only if a test happened to
 * cover it; and nothing pins what an *unsupported* language must do, which is
 * the promise the whole design rests on -- silence, never a guess.
 *
 * So: three fixture files under `tests/fixtures/`, the same logging feature in
 * each, and one table run against all of them. A language is either in
 * `SUPPORTED` and must get every verdict right, or it is not and must stay
 * quiet about all of it while saying so in the counts.
 *
 * Adding a language means adding a fixture and one row. If the row cannot be
 * made to pass, the language is not ready to ship.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { bodyOf, chainBreak, reaches, unsupportedMembers } from "../src/engine/body";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { languageOf, type Language } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

/**
 * One language's fixture, and what each member of the shared cast is called
 * in it. The tests below only ever speak in cast names.
 */
interface Fixture {
  /** Repo-relative path the board's refs will use. */
  file: string;
  /** Undefined for a language with no grammar. */
  language: Language | undefined;
  store: string;
  emitter: string;
  direct: string;
  silent: string;
  deep: string;
  mid: string;
  top: string;
  /** Every call of the emitter, so a test can delete them all. */
  callSites: RegExp;
  /** The emitter's own declaration, so a test can delete it. */
  declaration: RegExp;
  /** Turn a line into a comment, for the "commented out, not deleted" case. */
  comment: (line: string) => string;
}

const FIXTURES: Fixture[] = [
  {
    file: "src/logging.rs",
    language: "rust",
    store: "LOGGER",
    emitter: "log_line",
    direct: "serve_request",
    silent: "parse_header",
    deep: "emit_batch",
    mid: "handle_logging",
    top: "handle_fail",
    callSites: /^[ \t]*log_line!\([^;]*\);[ \t]*$/gm,
    declaration: /macro_rules! log_line \{[\s\S]*?\n\}\n/,
    comment: (line) => `// ${line.trim()}`,
  },
  {
    file: "src/logging.ts",
    language: "ts",
    store: "LOGGER",
    emitter: "logLine",
    direct: "serveRequest",
    silent: "parseHeader",
    deep: "emitBatch",
    mid: "handleLogging",
    top: "handleFail",
    callSites: /^[ \t]*logLine\([^;]*\);[ \t]*$/gm,
    declaration: /export function logLine\(message: string\): void \{[\s\S]*?\n\}\n/,
    comment: (line) => `// ${line.trim()}`,
  },
  {
    file: "src/logging.py",
    language: "python",
    store: "LOGGER",
    emitter: "log_line",
    direct: "serve_request",
    silent: "parse_header",
    deep: "emit_batch",
    mid: "handle_logging",
    top: "handle_fail",
    callSites: /^[ \t]*log_line\([^)]*\)[ \t]*$/gm,
    declaration: /def log_line\(message\):\n(?:[ \t]+.*\n)+/,
    comment: (line) => `# ${line.trim()}`,
  },
  {
    file: "src/logging.rb",
    language: undefined,
    store: "LOGGER",
    emitter: "log_line",
    direct: "serve_request",
    silent: "parse_header",
    deep: "emit_batch",
    mid: "handle_logging",
    top: "handle_fail",
    callSites: /^[ \t]*log_line\([^)]*\)[ \t]*$/gm,
    declaration: /def log_line\(message\)\n(?:[ \t]+.*\n)+end\n/,
    comment: (line) => `# ${line.trim()}`,
  },
];

function sourceOf(fixture: Fixture): string {
  return readFileSync(
    path.join(__dirname, "fixtures", path.basename(fixture.file)),
    "utf8",
  );
}

/** A function's body, for asserting that a mutation landed where it was aimed. */
function bodyOfIn(source: string, symbol: string, language: Language): string {
  return bodyOf(source, symbol, language) ?? "";
}

/**
 * Remove the emitter calls from the deepest function only.
 *
 * The hollow-concept case turns on this being surgical: every other member has
 * to keep working, so that the arrows stay green and the self-support rule is
 * demonstrably the only thing left that notices.
 */
function cutDeepestCall(fixture: Fixture, source: string): string {
  const language = fixture.language!;
  // A body is a slice of the real source, verbatim, so its text can be found
  // in the original and cut there. That property is what makes this surgery
  // possible at all, and it is asserted below.
  const body = bodyOf(source, fixture.deep, language)!;
  const start = source.indexOf(body);
  const end = start + body.length;
  fixture.callSites.lastIndex = 0;
  return source.slice(0, start)
    + source.slice(start, end).replace(fixture.callSites, "")
    + source.slice(end);
}

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] === undefined ? "missing" : "file"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

async function boardWith(
  nodes: Array<{ id: string; label: string; ref?: string; refs?: string[] }>,
  edges: Array<{ from: string; to: string; via?: string[] }> = [],
): Promise<BoardFile> {
  return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges })).board;
}

beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }]);
}, 60_000);

describe.each(FIXTURES)("$file", (fixture) => {
  const supported = fixture.language !== undefined;
  const source = sourceOf(fixture);
  const anchors = [
    `${fixture.file}#${fixture.store}@declared+used`,
    `${fixture.file}#${fixture.emitter}@declared+used`,
  ];

  /** The feature box, against one version of the file. */
  async function claim(code: string) {
    const board = await boardWith([
      { id: "log", label: "logging", ref: anchors[0], refs: [anchors[1]] },
    ]);
    return checkDrift(board, fakeWorkspace({ [fixture.file]: code }));
  }

  it("agrees the fixture is the language it claims to be", () => {
    expect(languageOf(fixture.file)).toBe(fixture.language);
  });

  it("is quiet on the untouched file", async () => {
    const report = await claim(source);
    expect(report.clean).toBe(true);
    expect(report.assertions).toEqual(
      supported
        ? { checked: 2, downgraded: 0, unsupportedLanguage: 0 }
        : { checked: 0, downgraded: 0, unsupportedLanguage: 2 },
    );
  });

  const damage: Array<[string, (code: string) => string]> = [
    ["every call site is deleted", (code) => code.replace(fixture.callSites, "")],
    ["the emitter's declaration is deleted", (code) => code.replace(fixture.declaration, "")],
    [
      "the call sites are commented out rather than deleted",
      (code) => code.replace(fixture.callSites, (line) => fixture.comment(line)),
    ],
  ];

  for (const [what, breakIt] of damage) {
    it(`${supported ? "flags" : "stays quiet, uncheckably"} when ${what}`, async () => {
      const report = await claim(breakIt(source));
      // An unsupported language falls back to a plain mention, and a mention
      // survives all three of these. That is the cost of no table, and it is
      // paid in misses rather than in false alarms.
      expect(report.clean).toBe(!supported);
    });
  }

  it("still notices the feature vanishing entirely, table or no table", async () => {
    // The one thing that works everywhere, because it needs no lexer.
    const report = await claim("// nothing to see here\n");
    expect(report.clean).toBe(false);
  });

  describe("arrows", () => {
    async function arrow(from: string, via?: string[]) {
      const board = await boardWith(
        [
          { id: "a", label: from, ref: `${fixture.file}#${from}` },
          {
            id: "b",
            label: "logging",
            ref: `${fixture.file}#${fixture.store}`,
            refs: [`${fixture.file}#${fixture.emitter}`],
          },
        ],
        [{ from: "a", to: "b", ...(via ? { via } : {}) }],
      );
      return checkDrift(board, fakeWorkspace({ [fixture.file]: source }));
    }

    it("is quiet from a function that logs directly", async () => {
      const report = await arrow(fixture.direct);
      expect(report.edges).toEqual([]);
    });

    it(`${supported ? "flags" : "cannot read"} an arrow from a function that never logs`, async () => {
      const report = await arrow(fixture.silent);
      if (supported) {
        expect(report.edges).toHaveLength(1);
      } else {
        // With no table, the symbols are not even collected, so this never
        // reaches the body check -- it skips at the file channels, which do
        // not read this language either. Counted, not guessed.
        expect(report.edges).toEqual([]);
        expect(report.edgesSkippedWhy).toEqual({ "unlicensed-language": 1 });
      }
    });

    it("is quiet from a function that logs only through a call it makes", async () => {
      // One layer down, which is exactly what the hop buys: extracting the
      // logging into a helper is a healthy refactor, and without the hop this
      // true arrow becomes a false alarm. Call syntax differs per language, so
      // this belongs here and not only in the Rust tests.
      const report = await arrow(fixture.mid);
      expect(report.edges).toEqual([]);
      if (supported) {
        // And prove it is the hop doing it, not a direct mention.
        expect(bodyOfIn(source, fixture.mid, fixture.language!)).not.toContain(fixture.emitter);
      }
    });

    it("is quiet on a three-layer chain, with no route named", async () => {
      // This used to flag: the search stopped after one hop, so a true arrow
      // through two intermediaries looked broken. Measured on two real files,
      // following the calls all the way costs no discrimination, so it does --
      // and this row went from "flags" to "quiet" on purpose.
      const report = await arrow(fixture.top);
      expect(report.edges).toEqual([]);
    });

    it("is quiet once the route is named", async () => {
      const report = await arrow(fixture.top, [fixture.mid, fixture.deep]);
      expect(report.edges).toEqual([]);
    });

    it(`${supported ? "names the broken hop" : "says nothing"} when the route is wrong`, async () => {
      const report = await arrow(fixture.top, [fixture.silent]);
      if (!supported) {
        expect(report.edges).toEqual([]);
        return;
      }
      expect(report.edges).toHaveLength(1);
      expect(report.edges[0].kind).toBe("broken-chain");
      // The failing link, both ends of it, so the reader can find the edit.
      expect(report.edges[0].detail).toContain(fixture.top);
      expect(report.edges[0].detail).toContain(fixture.silent);
      // `top` does reach the logging through its own chain, so the route being
      // wrong is the only complaint and the wording says exactly that. Before
      // the search followed depth this read as a missing connection.
      expect(report.edges[0].detail).toContain("still connected, but not by this route");
    });

    it(`${supported ? "says the route is stale" : "says nothing"} when the connection holds anyway`, async () => {
      // `direct` logs on its own, so a wrong route leaves the arrow true. That
      // is different news from a missing connection, and it reads differently.
      const report = await arrow(fixture.direct, [fixture.silent]);
      if (!supported) {
        expect(report.edges).toEqual([]);
        return;
      }
      expect(report.edges).toHaveLength(1);
      expect(report.edges[0].detail).toContain("still connected, but not by this route");
      expect(report.edges[0].detail).toContain(fixture.silent);
    });
  });

  describe("holding a concept together", () => {
    const members = () => [fixture.store, fixture.emitter, fixture.mid, fixture.deep];

    it("finds nothing wrong with the intact feature", () => {
      if (!supported) return;
      expect(unsupportedMembers(source, members(), fixture.language!)).toEqual([]);
    });

    it("catches the member that stopped doing anything", () => {
      if (!supported) return;
      const hollow = cutDeepestCall(fixture, source);
      // The cut has to be real, or the assertion below proves nothing.
      expect(bodyOfIn(hollow, fixture.deep, fixture.language!)).not.toContain(fixture.emitter);
      expect(bodyOfIn(hollow, fixture.direct, fixture.language!)).toContain(fixture.emitter);

      // Only the deepest link is gone. Callers still call listed members, so
      // every arrow stays green -- this rule is the one thing that notices.
      expect(unsupportedMembers(hollow, members(), fixture.language!)).toEqual([fixture.deep]);
      // And the arrow really does stay quiet, which is the hole being closed.
      expect(reaches(hollow, fixture.mid, [fixture.deep], fixture.language!)).toBe(true);
    });

    it("never complains about the store, which is the ground", () => {
      if (!supported) return;
      expect(unsupportedMembers(source, [fixture.store, fixture.emitter], fixture.language!))
        .toEqual([]);
    });
  });
});

/**
 * The claims that are about the set of languages rather than any one of them.
 */
describe("across the languages", () => {
  it("reads a body in every language that claims a table, and none that does not", () => {
    for (const fixture of FIXTURES) {
      const source = sourceOf(fixture);
      const answer = fixture.language
        ? reaches(source, fixture.direct, [fixture.emitter], fixture.language)
        : undefined;
      expect(answer, fixture.file).toBe(fixture.language ? true : undefined);
    }
  });

  it("walks a named route in every supported language", () => {
    for (const fixture of FIXTURES) {
      if (!fixture.language) continue;
      const source = sourceOf(fixture);
      expect(
        chainBreak(source, fixture.top, [fixture.mid, fixture.deep], [fixture.emitter], fixture.language),
        fixture.file,
      ).toBeUndefined();
    }
  });

  it("returns bodies as verbatim slices of the source, which other tools rely on", () => {
    // The surgery in this file finds a body by searching the original text for
    // it. That only works while a body is the exact substring the parser read,
    // with nothing normalised on the way out. Cheap to check, expensive to
    // discover by hand.
    for (const fixture of FIXTURES) {
      if (!fixture.language) continue;
      const source = sourceOf(fixture);
      const body = bodyOf(source, fixture.deep, fixture.language)!;
      expect(body, fixture.file).toBeDefined();
      expect(source.indexOf(body), fixture.file).toBeGreaterThanOrEqual(0);
      expect(source.indexOf(body), fixture.file).toBe(source.lastIndexOf(body));
    }
  });

  it("keeps the fixtures telling the same story", () => {
    // The whole table above is only meaningful if the fixtures really are the
    // same feature. Cheap structural check so a future edit to one of them
    // cannot quietly make a row vacuous.
    for (const fixture of FIXTURES) {
      const source = sourceOf(fixture);
      for (const name of [
        fixture.store, fixture.emitter, fixture.direct,
        fixture.silent, fixture.deep, fixture.mid, fixture.top,
      ]) {
        expect(source, `${fixture.file} is missing ${name}`).toContain(name);
      }
      // And the damage patterns have to bite, or "flags" would prove nothing.
      expect(fixture.callSites.test(source), `${fixture.file}: no call sites matched`).toBe(true);
      fixture.callSites.lastIndex = 0;
      expect(fixture.declaration.test(source), `${fixture.file}: declaration not matched`).toBe(true);
    }
  });
});
