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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
