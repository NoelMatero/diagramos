/**
 * A ref into build output.
 *
 * The bug this file exists for (#166): a box was anchored at
 * `lib_shared/target/debug/.fingerprint/lib_shared-e44f0492/output-test-lib`,
 * and the check reported it clean. The file was there, so the ref resolved, so
 * nothing had anything to say -- and nothing ever would, because renaming or
 * deleting the function the box was meant to describe does not touch a
 * fingerprint file. The board looked checked. That box was not.
 *
 * The negative tests are the ones that matter here. Refusing a ref is an
 * accusation against something a person typed, and the second half of this file
 * is every place a directory shares a name with build output and is not it --
 * starting with `src/engine/vendor/`, which is in this repository.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { NEVER_WALK } from "../src/engine/generated";
import { LICENCES } from "../src/engine/licence";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

/** Directories inferred from the paths, so a ref can ask what sits beside it. */
function treeWorkspace(files: Record<string, string>): Workspace {
  const norm = (target: string) => {
    const trimmed = target.replace(/^\.\//, "");
    return trimmed === "" || trimmed === "." ? "." : trimmed;
  };
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : norm(relative)),
    stat: (target) => {
      const at = norm(target);
      if (at === ".") return "directory";
      if (files[at] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${at}/`)) ? "directory" : "missing";
    },
    read: (target) => files[norm(target)] ?? "",
    list: (target) => {
      const at = norm(target);
      const prefix = at === "." ? "" : `${at}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

const CARGO = '[package]\nname = "lib_shared"\nedition = "2021"\n';
const PACKAGE = '{ "name": "demo" }\n';

async function boardWith(
  nodes: Array<{ id: string; label: string; ref?: string }>,
  edges: Array<{ from: string; to: string }> = [],
): Promise<BoardFile> {
  return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges })).board;
}

beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }]);
}, 60_000);

/** The exact anchor from the run that surfaced this, and the tree it sat in. */
const FINGERPRINT =
  "orangutan_macro/lib_shared/target/debug/.fingerprint/lib_shared-e44f0492045ea91e"
  + "/output-test-lib-lib_shared";

const RUST_TREE = {
  "orangutan_macro/lib_shared/Cargo.toml": CARGO,
  "orangutan_macro/lib_shared/src/request.rs": "pub fn from_str(raw: &str) -> Request { todo!() }",
  [FINGERPRINT]: '{"$message_type":"diagnostic"}',
};

describe("a ref into build output", () => {
  it("is a finding, not a pass", async () => {
    const board = await boardWith([{ id: "req", label: "Request", ref: FINGERPRINT }]);
    const report = checkDrift(board, treeWorkspace(RUST_TREE));

    expect(report.clean).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ node: "req", kind: "generated-ref" });
    // The sentence has to name the directory and the manifest that produces it,
    // because "your ref is wrong" without either is a puzzle rather than a fix.
    expect(report.findings[0].detail).toContain("orangutan_macro/lib_shared/target");
    expect(report.findings[0].detail).toContain("orangutan_macro/lib_shared/Cargo.toml");
  });

  it("is not reported as unresolvable, which would be a false statement", async () => {
    const board = await boardWith([{ id: "req", label: "Request", ref: FINGERPRINT }]);
    const report = checkDrift(board, treeWorkspace(RUST_TREE));
    // The path *is* in the repo and the file *is* on disk. That is the problem,
    // and a reader told "not a path in this repo" goes looking for the wrong bug.
    expect(report.findings[0].kind).not.toBe("unresolvable-ref");
  });

  it("still reports a missing file as missing when the build directory is cleaned", async () => {
    const board = await boardWith([{ id: "req", label: "Request", ref: FINGERPRINT }]);
    const report = checkDrift(board, treeWorkspace({
      "orangutan_macro/lib_shared/Cargo.toml": CARGO,
    }));
    // `cargo clean` should not change which word a broken ref gets. What is
    // wrong with the box is the same either way, and "gone" is the more useful
    // half of it.
    expect(report.findings[0]).toMatchObject({ kind: "missing-file" });
  });

  it("catches the JavaScript directories too", async () => {
    const tree = {
      "package.json": PACKAGE,
      "dist/bundle.js": "export const x = 1;",
      "node_modules/left-pad/index.js": "module.exports = 1;",
      "src/index.ts": "export const x = 1;",
    };
    const board = await boardWith([
      { id: "bundle", label: "Bundle", ref: "dist/bundle.js" },
      { id: "dep", label: "left-pad", ref: "node_modules/left-pad/index.js" },
      { id: "src", label: "Source", ref: "src/index.ts" },
    ]);
    const report = checkDrift(board, treeWorkspace(tree));
    expect(report.findings.map((finding) => finding.node).sort()).toEqual(["bundle", "dep"]);
    expect(report.findings.every((finding) => finding.kind === "generated-ref")).toBe(true);
  });

  it("withdraws an inferred anchor instead of accusing a label", async () => {
    // The ref was read off the label, so there is nothing anybody wrote to
    // correct -- the same silence a label pointing outside the repo already gets.
    const board = await boardWith([{ id: "bundle", label: "dist/bundle.js" }]);
    const report = checkDrift(board, treeWorkspace({
      "package.json": PACKAGE,
      "dist/bundle.js": "export const x = 1;",
    }));
    expect(report.findings).toEqual([]);
    expect(report.skippedWhy).toMatchObject({ "ref-generated": 1 });
  });
});

describe("an arrow with an end in build output", () => {
  it("says so, instead of blaming the language", async () => {
    const board = await boardWith(
      [
        { id: "req", label: "Request", ref: FINGERPRINT },
        { id: "src", label: "Parser", ref: "orangutan_macro/lib_shared/src/request.rs" },
      ],
      [{ from: "src", to: "req" }],
    );
    const report = checkDrift(board, treeWorkspace(RUST_TREE));
    // Before this, `languageOf` had no answer for a fingerprint file, so the
    // arrow was counted as "no licence for that language" -- which reads as a
    // gap in Rust support and sent somebody looking for one.
    expect(report.edgesSkippedWhy).toMatchObject({ "endpoint-generated": 1 });
    expect(report.edgesSkippedWhy["unlicensed-language"]).toBeUndefined();
  });
});

describe("a directory that only shares the name", () => {
  it("leaves source alone when no manifest produces the directory", async () => {
    // `src/engine/vendor/browser-shim.ts` is a real file in this repository. A
    // check that refused it on the name alone would be a red nobody can clear.
    const board = await boardWith([
      { id: "shim", label: "Shim", ref: "src/engine/vendor/browser-shim.ts" },
      { id: "target", label: "Targets", ref: "src/target/resolve.ts" },
    ]);
    const report = checkDrift(board, treeWorkspace({
      "package.json": PACKAGE,
      "src/engine/vendor/browser-shim.ts": "export const x = 1;",
      "src/target/resolve.ts": "export const y = 1;",
    }));
    expect(report).toMatchObject({ clean: true, findings: [], checked: 2 });
  });

  it("refuses a nested build directory that does have its manifest", async () => {
    // The other half of the same rule: a monorepo package builds into its own
    // `dist`, three levels down, and that is still build output.
    const board = await boardWith([
      { id: "built", label: "Built", ref: "packages/ui/dist/index.js" },
    ]);
    const report = checkDrift(board, treeWorkspace({
      "packages/ui/package.json": PACKAGE,
      "packages/ui/dist/index.js": "export const x = 1;",
    }));
    expect(report.findings[0]).toMatchObject({ kind: "generated-ref" });
    expect(report.findings[0].detail).toContain("packages/ui/dist");
  });
});

describe("the list the walks share", () => {
  it("has a build directory for every language the licence covers", () => {
    // The bug behind the bug: every name on this list was a JavaScript
    // convention, so Rust's `target` -- often the largest thing in the
    // repository -- was walked in full. Adding a language to `licence.ts`
    // without adding its build directory here brings that back.
    const BUILD_DIRECTORY: Record<string, string> = {
      typescript: "node_modules",
      rust: "target",
    };
    for (const licence of LICENCES) {
      const directory = BUILD_DIRECTORY[licence.language];
      expect(directory, `no build directory recorded for ${licence.language}`).toBeDefined();
      expect(NEVER_WALK.has(directory!), `${directory} missing from NEVER_WALK`).toBe(true);
    }
  });
});
