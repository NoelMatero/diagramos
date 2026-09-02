/**
 * `@holds` as it reaches a report (#188).
 *
 * `engine-holds.test.ts` covers the reader. What is covered here is the half
 * that decides what anybody is told: which answer becomes a red finding, which
 * becomes silence, and whether a claim nobody could check is distinguishable in
 * the report from a claim that passed.
 *
 * The board this word exists for is the live red on orangutan's:
 *
 *     RouteInfo { path, methods, handler }  --[@takes]-->  hello_handler(&Request)
 *
 * drawn by hand by the person who wrote the Rust, correct in every respect
 * except that the only available word said something else. The first test here
 * is that arrow with the right word on it.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

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

/**
 * Two type boxes, with the arrow drawn holder -> held.
 *
 * That direction is the decision recorded in `holds.ts`: the author of the one
 * hand-drawn claim in this project's corpus drew it that way, and UML points
 * whole to part. It is the opposite end from `takes`, where the declaration
 * being read sits at the *to* end.
 */
async function boardOf(
  holderRef: string,
  heldRef: string,
  edge: { claim?: "holds" | "takes"; state?: "planned" } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "holder", label: "RouteInfo", ref: holderRef },
      { id: "held", label: "Response", ref: heldRef },
    ],
    edges: [{ from: "holder", to: "held", ...edge }],
  });
  return board;
}

const ROUTE_INFO = [
  "pub struct RouteInfo {",
  "    pub path: String,",
  "    pub handler: fn(&Request) -> Response,",
  "}",
  "",
].join("\n");

const RESPONSE = "pub struct Response { pub body: Vec<u8> }\n";

const files = (routeInfo = ROUTE_INFO) => ({
  "src/route.rs": routeInfo,
  "src/response.rs": RESPONSE,
});

describe("@holds on the arrow the word exists for", () => {
  it("confirms the case that was red before the word existed", async () => {
    const board = await boardOf("src/route.rs#RouteInfo", "src/response.rs#Response", { claim: "holds" });
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "holds-absent")).toEqual([]);
    expect(report.claims.holds).toBe(1);
    expect(report.claims.holdsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("@holds on an arrow the code contradicts", () => {
  it("reports it in red, quoting the field list it read", async () => {
    // RouteInfo's fields are enumerable, every name means itself, and Response
    // is not among them. This is the verdict that can fail a build.
    const withoutResponse = "pub struct RouteInfo { pub path: String }\n";
    const board = await boardOf("src/route.rs#RouteInfo", "src/response.rs#Response", { claim: "holds" });
    const report = checkDrift(board, fakeWorkspace(files(withoutResponse)), { edges: true });

    const finding = report.edges.find((edge) => edge.kind === "holds-absent");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("path: String");
    expect(report.clean).toBe(false);
  });

  it("says nothing when the field list could be hiding the name", async () => {
    // `Res` is `Response` by another name, so absence proves nothing. Silence,
    // never an accusation -- the whole reason `holds.ts` is written the way it is.
    const aliased = [
      "type Res = Response;",
      "pub struct RouteInfo { pub handler: Res }",
      "",
    ].join("\n");
    const board = await boardOf("src/route.rs#RouteInfo", "src/response.rs#Response", { claim: "holds" });
    const report = checkDrift(board, fakeWorkspace(files(aliased)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "holds-absent")).toEqual([]);
    expect(report.claims.holdsWithheld.aliased).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("a category error is not a wrong diagram", () => {
  it("says nothing when the far end is a function rather than a type", async () => {
    /*
     * The live arrow on orangutan's board, which is what this word was added
     * for -- and it turns out `@holds` is not true of it either. `RouteInfo`
     * has a field typed `fn(&Request) -> Response`; `hello_handler` is a
     * function that fits that type, not a type the field is of.
     *
     * So the far end is the wrong *sort* of thing, which is #190's layer 1: a
     * claim between a type and a routine is a category error rather than a
     * false statement, and the engine must not answer a question it was never
     * going to be able to answer. Silence, never red.
     */
    const files = {
      "src/route.rs": "pub struct RouteInfo { pub handler: fn(&Request) -> Response }\n",
      "src/main.rs": "fn hello_handler(_request: &Request) -> Response { todo!() }\n",
    };
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "holder", label: "RouteInfo", ref: "src/route.rs#RouteInfo" },
        { id: "held", label: "hello_handler", ref: "src/main.rs#hello_handler" },
      ],
      edges: [{ from: "holder", to: "held", claim: "holds" }],
    });
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    // Not red -- a red says the code disagrees, and the code does not disagree
    // with anything here; nothing was ever asked of it.
    expect(report.edges.filter((finding) => finding.kind === "holds-absent")).toEqual([]);
    expect(report.claims.holdsWithheld["not-a-type"]).toBe(1);

    /*
     * But loud. The first version of this went silent, and that was backwards:
     * a claim that can never be satisfied is a line on the board no check can
     * ever read, which is exactly what `garbledClaims` is for and exactly the
     * comment on `clean` -- "leaving it out would let it sit there quietly
     * forever". #190 says a category error should be caught the moment the
     * arrow is drawn rather than silently withheld, and silence is what a
     * checker that was never going to answer looks like.
     */
    const garbled = report.garbledClaims.find((claim) => claim.written === "holds");
    expect(garbled).toBeDefined();
    expect(garbled?.on).toBe("arrow");
    expect(garbled?.detail).toContain("hello_handler");
    expect(report.clean).toBe(false);
  });
});

describe("a claim nobody could check is not a claim that passed", () => {
  it("counts a withheld claim apart from a confirmed one", async () => {
    const board = await boardOf("src/route.rs#Missing", "src/response.rs#Response", { claim: "holds" });
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });

    expect(report.claims.holdsConfirmed).toBe(0);
    expect(Object.values(report.claims.holdsWithheld).some((count) => count > 0)).toBe(true);
  });
});

describe("a planned arrow is a specification, not an accusation", () => {
  it("refuses the red on a field list that does not exist yet", async () => {
    const withoutResponse = "pub struct RouteInfo { pub path: String }\n";
    const board = await boardOf("src/route.rs#RouteInfo", "src/response.rs#Response", {
      claim: "holds", state: "planned",
    });
    const report = checkDrift(board, fakeWorkspace(files(withoutResponse)), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "holds-absent")).toEqual([]);
    expect(report.clean).toBe(true);
  });
});
