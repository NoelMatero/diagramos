/**
 * A claim is confirmed by its own check, or it is not confirmed (#304).
 *
 * Every claim word has a reader of its own: `needs` reads import
 * declarations, `holds` reads a field list, `calls` reads a body. When one of
 * those cannot answer, the arrow used to fall through to the plain
 * corroboration channels, which confirm on an import either way, a file that
 * imports both ends, a shared route, or a call chain found in a body. Those
 * channels are the right answer for an arrow that claims nothing. On an arrow
 * carrying a claim they confirm something nobody checked, and the arrow renders
 * exactly like one whose claim held.
 *
 * Two shapes, both measured before this file was written (the probe in #304):
 *
 * 1. **A third file imports both ends.** All nine words, all three languages,
 *    came back green on this -- including `@needs` between two files where
 *    neither imports the other, which is the worst case in the issue.
 * 2. **A call chain reaches, one hop further than the claim's own reader
 *    looks.** `@calls` means a call, and a two-hop chain is not one.
 *
 * The expectation everywhere here is *not verified*, never red: no channel in
 * either shape refutes anything, and an arrow whose claim could not be read is
 * not an arrow the code disagrees with.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { loadCodeGraph } from "../src/engine/codegraph";
import { initEngine } from "../src/engine/parse";
import { ARROW_CLAIMS, type ArrowClaim } from "../src/engine/claim";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/**
 * The file map with directories inferred, because Rust needs a walk: the
 * module tree is built from the `Cargo.toml` files in the tree, and a
 * workspace that cannot list a directory has no crates and therefore no
 * readable Rust (`readerCanPlace` in `deps.ts`).
 */
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

interface Tree {
  /** Extension, so the refs can be written once per language. */
  ext: string;
  files: Record<string, string>;
}

/**
 * Three files per language: `api` and `model` never name each other, and `hub`
 * imports both. That is corroboration channel 3 and nothing else.
 */
const SHARED_IMPORTER: Record<string, Tree> = {
  rust: {
    ext: "rs",
    files: {
      "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n',
      "src/lib.rs": "pub mod api;\npub mod model;\npub mod hub;\n",
      "src/api.rs": "pub struct Alpha { pub a: i32 }\n\npub fn tail() -> i32 { 1 }\n",
      "src/model.rs": "pub struct Beta { pub b: i32 }\n\npub fn head() -> i32 { 2 }\n",
      "src/hub.rs":
        "use crate::api::tail;\nuse crate::model::head;\n\npub fn run() -> i32 { tail() + head() }\n",
    },
  },
  python: {
    ext: "py",
    files: {
      "src/api.py": "class Alpha:\n    a: int = 1\n\ndef tail():\n    return 1\n",
      "src/model.py": "class Beta:\n    b: int = 2\n\ndef head():\n    return 2\n",
      "src/hub.py":
        "from .api import tail\nfrom .model import head\n\ndef run():\n    return tail() + head()\n",
    },
  },
  typescript: {
    ext: "ts",
    files: {
      "src/api.ts": "export class Alpha { a = 1; }\n\nexport function tail() { return 1; }\n",
      "src/model.ts": "export class Beta { b = 2; }\n\nexport function head() { return 2; }\n",
      "src/hub.ts":
        'import { tail } from "./api";\nimport { head } from "./model";\n\n'
        + "export function run() { return tail() + head(); }\n",
    },
  },
};

const LANGUAGES = Object.keys(SHARED_IMPORTER);

async function boardOf(
  fromRef: string,
  toRef: string,
  claim: ArrowClaim,
  hubRef: string | undefined,
  label?: string,
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "api", ref: fromRef },
      { id: "head", label: "model", ref: toRef },
      ...(hubRef ? [{ id: "hub", label: "hub", ref: hubRef }] : []),
    ],
    edges: [{ from: "tail", to: "head", claim, ...(label ? { label } : {}) }],
  });
  return board;
}

/** What a person sees for the one arrow on the board. */
function verdictOf(board: BoardFile, files: Record<string, string>) {
  const report = checkDrift(board, treeWorkspace(files), { edges: true });
  return {
    report,
    red: report.edges[0],
    notVerified: report.unconfirmedEdges[0],
    confirmed: report.edgesChecked - report.unconfirmedEdges.length,
  };
}

describe("a third file importing both ends is not a check of the claim", () => {
  for (const claim of ARROW_CLAIMS) {
    it.each(LANGUAGES)(`@${claim} in %s is not verified, not green`, async (language) => {
      const { ext, files } = SHARED_IMPORTER[language]!;
      const board = await boardOf(
        `src/api.${ext}`,
        `src/model.${ext}`,
        claim,
        `src/hub.${ext}`,
        // `accesses` needs a member name to read; nothing on `model` has it.
        claim === "accesses" ? "b" : undefined,
      );
      const { red, notVerified, confirmed } = verdictOf(board, files);

      if (claim === "needs" || claim === "depends") {
        // Since #323 an import that is not there is a red for both import
        // words, and this is that shape: `api` imports nothing, so nothing it
        // imports leads to `model`. Still never green off the shared importer.
        expect(red?.kind).toBe("needs-absent");
        expect(notVerified).toBeUndefined();
        return;
      }
      expect(red).toBeUndefined();
      expect(confirmed).toBe(0);
      expect(notVerified).toBeDefined();
      // The first Rust arrow pays for the module tree and the grammar, and
      // this suite shares the machine with other sessions' vitest runs.
    }, 120_000);
  }

  it("says why, and names the claim rather than the channels", async () => {
    const { files } = SHARED_IMPORTER.typescript!;
    // `builds`, since `needs` answers this shape with a red (#323).
    const board = await boardOf("src/api.ts", "src/model.ts", "builds", "src/hub.ts");
    const { notVerified } = verdictOf(board, files);

    expect(notVerified?.reason).toBe("claim-not-checked");
    expect(notVerified?.detail).toContain("@builds");
  });
});

/**
 * An arrow that claims nothing is the case those channels were built for, and
 * this fix must not take it away: the same two files, the same third importer,
 * no claim, still green.
 */
describe("an arrow with no claim keeps the channels", () => {
  it.each(LANGUAGES)("is confirmed in %s by the shared importer", async (language) => {
    const { ext, files } = SHARED_IMPORTER[language]!;
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "tail", label: "api", ref: `src/api.${ext}` },
        { id: "head", label: "model", ref: `src/model.${ext}` },
        { id: "hub", label: "hub", ref: `src/hub.${ext}` },
      ],
      edges: [{ from: "tail", to: "head" }],
    });
    const { red, notVerified, confirmed } = verdictOf(board, files);

    expect(red).toBeUndefined();
    expect(notVerified).toBeUndefined();
    expect(confirmed).toBe(1);
  });
});

/**
 * The second shape: a claim whose own reader looks at a body, where the body
 * reaches the far end one hop further out than the claim allows.
 *
 * `tail` calls `mid`, `mid` calls `head`. `@calls` means `tail` calls `head`,
 * and it does not. The chain search that backs a plain arrow follows calls as
 * deep as they go, so it used to confirm the claim anyway.
 */
const CHAIN: Record<string, Tree> = {
  rust: {
    ext: "rs",
    files: {
      "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n',
      "src/lib.rs": "pub mod api;\n",
      "src/api.rs":
        "pub fn tail() -> i32 { mid() }\n\npub fn mid() -> i32 { head() }\n\npub fn head() -> i32 { 3 }\n",
    },
  },
  python: {
    ext: "py",
    files: {
      "src/api.py":
        "def tail():\n    return mid()\n\ndef mid():\n    return head()\n\ndef head():\n    return 3\n",
    },
  },
  typescript: {
    ext: "ts",
    files: {
      "src/api.ts":
        "export function tail() { return mid(); }\n\n"
        + "export function mid() { return head(); }\n\n"
        + "export function head() { return 3; }\n",
    },
  },
};

describe("a call chain is not the claim's own check", () => {
  it.each(LANGUAGES)("@calls two hops away is not verified in %s", async (language) => {
    const { ext, files } = CHAIN[language]!;
    const board = await boardOf(`src/api.${ext}#tail`, `src/api.${ext}#head`, "calls", undefined);
    const { red, notVerified, confirmed } = verdictOf(board, files);

    expect(red).toBeUndefined();
    expect(confirmed).toBe(0);
    expect(notVerified).toBeDefined();
  });

  it.each(LANGUAGES)("@needs inside one file is not verified in %s", async (language) => {
    const { ext, files } = CHAIN[language]!;
    const board = await boardOf(`src/api.${ext}#tail`, `src/api.${ext}#head`, "needs", undefined);
    const { red, notVerified, confirmed } = verdictOf(board, files);

    expect(red).toBeUndefined();
    expect(confirmed).toBe(0);
    expect(notVerified).toBeDefined();
  });

  it.each(LANGUAGES)("an unclaimed arrow over the same chain stays green in %s", async (language) => {
    const { ext, files } = CHAIN[language]!;
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "tail", label: "tail", ref: `src/api.${ext}#tail` },
        { id: "head", label: "head", ref: `src/api.${ext}#head` },
      ],
      edges: [{ from: "tail", to: "head" }],
    });
    const { red, notVerified, confirmed } = verdictOf(board, files);

    expect(red).toBeUndefined();
    expect(notVerified).toBeUndefined();
    expect(confirmed).toBe(1);
  });
});

/**
 * The same defect one step earlier in the loop: an end standing for a whole
 * directory, where the code graph knows something under it reaches the other
 * end (#304).
 *
 * That is a real answer to "are these connected" and no answer at all to
 * "@needs" -- the claim is about two files and one end here is a set of them.
 * The comment at that call site said exactly that, counted the claim as one
 * that got no verdict, and confirmed the arrow anyway.
 */
describe("the code graph does not confirm a claim over a directory", () => {
  const files = {
    "src/sub/inner.ts": "export function inner() {}",
    "src/b.ts": "export function called() {}",
  };

  /** `src/sub` is a directory; the graph knows a file inside it reaches `b`. */
  const workspace: Workspace = {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) =>
      target === "src/sub" ? "directory"
        : files[target as keyof typeof files] === undefined ? "missing" : "file",
    read: (target) => files[target as keyof typeof files] ?? "",
    list: () => [],
  };

  const graph = () => {
    const loaded = loadCodeGraph(
      {
        nodes: [
          { id: "inner", source_file: "src/sub/inner.ts" },
          { id: "b_target", source_file: "src/b.ts" },
        ],
        links: [{ source: "inner", target: "b_target", relation: "calls", confidence: "EXTRACTED" }],
      },
      "0.9.47",
    );
    expect(loaded).toBeDefined();
    return loaded!;
  };

  async function board(claim: ArrowClaim | undefined) {
    const { board: built } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "a", label: "A", ref: "src/sub" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      edges: [{ from: "a", to: "b", ...(claim ? { claim } : {}) }],
    });
    return built;
  }

  it("leaves a @needs arrow over a directory unread, with the reason", async () => {
    const report = checkDrift(await board("needs"), workspace, {
      edges: true,
      codeGraph: { graph: graph(), modified: new Set() },
    });

    expect(report.edges).toHaveLength(0);
    expect(report.edgesSkippedWhy["directory-ref"]).toBe(1);
    expect(report.claims.needsWithheld).toEqual({ "directory-ref": 1 });
    expect(report.edgesChecked).toBe(0);
  });

  it("still confirms the same arrow when it claims nothing", async () => {
    const report = checkDrift(await board(undefined), workspace, {
      edges: true,
      codeGraph: { graph: graph(), modified: new Set() },
    });

    expect(report.edges).toHaveLength(0);
    expect(report.unconfirmedEdges).toHaveLength(0);
    expect(report.edgesSkippedWhy["directory-ref"]).toBeUndefined();
    expect(report.edgesChecked).toBe(1);
  });
});
