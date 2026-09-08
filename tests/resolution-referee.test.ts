/**
 * `createTsReferee`'s own bug, found building #226's tier-2 measurement: it
 * asked `ts.findConfigFile` at the *tree root* for a monorepo's tsconfig, and
 * that search only ever walks upward. A package's own config, one or more
 * directories below the root, was never reached -- every file in it built
 * with generic defaults, no `paths`, and `measure:resolution`'s first
 * monorepo run under-reported tier 2's reach for exactly this reason before
 * it had a name. These are the two shapes that prove the fix: a package's own
 * alias resolves when its config is one level down, and two sibling packages
 * each get their own answer rather than one bleeding into the other.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTsReferee } from "../scripts/lib/resolution-ts";

let repo: string;

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** Byte range of `needle`'s first occurrence in `source`, for a `typeAt` query. */
function rangeOf(source: string, needle: string): { start: number; end: number } {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not found`);
  return { start, end: start + needle.length };
}

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "resolution-referee-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("createTsReferee against a monorepo", () => {
  it("resolves through a package's own path alias when its tsconfig is below the tree root", () => {
    // No tsconfig at `repo` itself -- only `pkg/tsconfig.json` declares the
    // alias. `ts.findConfigFile(repo, ...)` searching upward from `repo`
    // would never see it; only a per-file nearest-config search does.
    write(
      "pkg/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["lib/*"] },
          target: "ES2020",
          module: "ESNext",
          moduleResolution: "bundler",
        },
      }),
    );
    write("pkg/lib/thing.ts", "export class Thing { greet(): string { return \"hi\"; } }\n");
    const index = "import { Thing } from \"@lib/thing\";\nconst t = new Thing();\nt.greet();\n";
    write("pkg/src/index.ts", index);

    const referee = createTsReferee(repo);
    const file = path.join(repo, "pkg/src/index.ts");
    // `t.greet()`'s receiver -- the line starts with it, so this is
    // unambiguous even though `const t` earlier also binds one letter `t`.
    const { start } = rangeOf(index, "t.greet()");
    const answer = referee.typeAt(file, start, start + 1);

    expect(answer?.head).toBe("Thing");
  });

  it("keeps two sibling packages' aliases apart instead of one answering for both", () => {
    write(
      "a/tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@x": ["./one"] }, moduleResolution: "bundler" } }),
    );
    write("a/one.ts", "export class FromA {}\n");
    const aSource = "import { FromA } from \"@x\";\nconst v = new FromA();\nv;\n";
    write("a/index.ts", aSource);

    write(
      "b/tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@x": ["./two"] }, moduleResolution: "bundler" } }),
    );
    write("b/two.ts", "export class FromB {}\n");
    const bSource = "import { FromB } from \"@x\";\nconst v = new FromB();\nv;\n";
    write("b/index.ts", bSource);

    const referee = createTsReferee(repo);

    const aRange = rangeOf(aSource, "v;");
    const bRange = rangeOf(bSource, "v;");
    const aAnswer = referee.typeAt(path.join(repo, "a/index.ts"), aRange.start, aRange.start + 1);
    const bAnswer = referee.typeAt(path.join(repo, "b/index.ts"), bRange.start, bRange.start + 1);

    expect(aAnswer?.head).toBe("FromA");
    expect(bAnswer?.head).toBe("FromB");
  });
});

/**
 * `concrete` (#233): whether a resolved type's first declaration is a class
 * a `callsBetween` closed-body accusation may actually rest on, or an
 * interface/abstract class/type parameter where the method reached at
 * runtime can live on a different class than the one named. Every existing
 * test of the guard (`tests/engine-calls.test.ts`) supplies `concrete` as a
 * mock boolean and checks that `closedBodyRefutes` respects it -- none of
 * them exercise `isConcreteDeclaration` itself against a real compiler,
 * which is the one function this whole safety property rests on.
 */
describe("createTsReferee's concrete field", () => {
  it("is true for an ordinary class", () => {
    const source = "class Foo {\n  run(): void {}\n}\nconst f = new Foo();\nf.run();\n";
    write("a.ts", source);
    const referee = createTsReferee(repo);
    const { start } = rangeOf(source, "f.run()");
    const answer = referee.typeAt(path.join(repo, "a.ts"), start, start + 1);
    expect(answer?.head).toBe("Foo");
    expect(answer?.concrete).toBe(true);
  });

  it("is false for an interface -- the shape the guard exists for", () => {
    const source =
      "interface Foo {\n  run(): void;\n}\nfunction use(f: Foo) {\n  f.run();\n}\n";
    write("a.ts", source);
    const referee = createTsReferee(repo);
    const { start } = rangeOf(source, "f.run()");
    const answer = referee.typeAt(path.join(repo, "a.ts"), start, start + 1);
    expect(answer?.head).toBe("Foo");
    expect(answer?.concrete).toBe(false);
  });

  it("is false for an abstract class", () => {
    const source =
      "abstract class Foo {\n  abstract run(): void;\n}\nfunction use(f: Foo) {\n  f.run();\n}\n";
    write("a.ts", source);
    const referee = createTsReferee(repo);
    const { start } = rangeOf(source, "f.run()");
    const answer = referee.typeAt(path.join(repo, "a.ts"), start, start + 1);
    expect(answer?.head).toBe("Foo");
    expect(answer?.concrete).toBe(false);
  });

  it("is false for a bare type parameter", () => {
    const source =
      "function use<T extends { run(): void }>(f: T) {\n  f.run();\n}\n";
    write("a.ts", source);
    const referee = createTsReferee(repo);
    const { start } = rangeOf(source, "f.run()");
    const answer = referee.typeAt(path.join(repo, "a.ts"), start, start + 1);
    expect(answer?.concrete).toBe(false);
  });
});

/**
 * The one thing #234 must never regress: a `createTsReferee` instance kept
 * alive across calls -- the whole point of #234's cache -- has to answer a
 * later query about edited source with the edit, not with whatever it
 * learned the first time it built a program for that file. A cache that
 * stays warm by staying wrong is a worse failure than the slowness it
 * replaced (docs/claim-vocabulary.md's own argument, one level up: a false
 * answer nobody can see is not recoverable by being fast).
 *
 * `foo.ts` is edited here, not `a.ts` -- the file the query is actually
 * asked about never changes. This is the harder, more honest version of the
 * test: it is not enough for the cache to notice the one file it was just
 * asked about changed, because `a`'s receiver's *type* lives in a file nowhere
 * near the query's own byte range. The whole program `a.ts` was built inside
 * has to be checked, not just `a.ts` itself.
 */
describe("a cached program invalidates when a file it was built from changes (#234)", () => {
  it("answers a later query about the edit, not about what the file used to say", () => {
    write("foo.ts", "export class Foo {\n  run(): void {}\n}\n");
    const source = 'import { Foo } from "./foo";\nfunction use(f: Foo) {\n  f.run();\n}\n';
    write("a.ts", source);

    // One referee, kept alive across both queries -- a fresh one per query
    // would trivially "pass" this by never having a stale answer to give.
    const referee = createTsReferee(repo);
    const { start } = rangeOf(source, "f.run()");
    const before = referee.typeAt(path.join(repo, "a.ts"), start, start + 1);
    expect(before?.concrete).toBe(true);

    // `foo.ts` changes from a class to an interface -- `a.ts` itself is
    // untouched, and its own mtime does not move.
    write("foo.ts", "export interface Foo {\n  run(): void;\n}\n");
    // Forced forward rather than trusted to the filesystem's own clock: some
    // filesystems only carry mtime to the nearest second, and a real edit a
    // person makes is not reliably a full second apart from the read before
    // it. The cache's own freshness check reads real mtimes either way; only
    // the fixture's clock is being made deterministic here.
    const bumped = new Date(Date.now() + 60_000);
    utimesSync(path.join(repo, "foo.ts"), bumped, bumped);

    const after = referee.typeAt(path.join(repo, "a.ts"), start, start + 1);
    expect(after?.concrete).toBe(false);
  });
});
