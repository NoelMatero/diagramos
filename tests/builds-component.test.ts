/**
 * A correct "App makes Widget" arrow stays quiet however App renders Widget (#363).
 *
 * Widget is a React function component, and a function is not a type -- so
 * the end-kind check called the arrow wrong unless the construction reader
 * had already seen `<Widget />` written in App and confirmed it. Every other
 * way of rendering the same component was accused: `createElement(Widget)`,
 * `memo(Widget)`, an alias, a component handed to a child as a prop.
 *
 * Whether a function can be made is a fact about the function, not about how
 * one caller wrote the render. What is pinned here, one test per shape in real
 * source: each correct arrow is not called wrong, and a plain function that
 * renders nothing still is.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheck } from "../src/engine/referee";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string;

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  // Outside the worktree on purpose: a scratch source file inside one is read
  // by the dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "builds-component-"));
  write("tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, jsx: "react-jsx" },
  }));
  // React's own types, so the compiler answers the way it does in a real app.
  mkdirSync(path.join(repo, "node_modules/@types"), { recursive: true });
  symlinkSync(path.resolve("node_modules/@types/react"), path.join(repo, "node_modules/@types/react"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function boardOf(fromRef: string, toRef: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "App", ref: fromRef },
      { id: "head", label: "Widget", ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim: "builds" }],
  });
  return board;
}

/** A check the way every product path runs one: plain first, the compiler if it would help. */
function refereed(board: BoardFile): DriftReport {
  const workspace = createWorkspace(repo);
  return refereedCheck(repo, (referee) => checkDrift(board, workspace, referee ? { closedBodyReferee: referee } : {}));
}

const wrongKind = (report: DriftReport) => report.edges.find((edge) => edge.kind === "end-lacks-part");

const WIDGET = "export function Widget(props: { n: number }) {\n"
  + "  return <div>{props.n}</div>;\n"
  + "}\n"
  + "export default Widget;\n";

/** Each way App renders Widget, as written in real source. */
const SHAPES: Array<[string, Record<string, string>]> = [
  ["createElement", {
    "src/Widget.tsx": WIDGET,
    "src/App.tsx": "import { createElement } from \"react\";\nimport { Widget } from \"./Widget\";\n"
      + "export function App() {\n  return createElement(Widget, { n: 1 });\n}\n",
  }],
  ["memo", {
    "src/Widget.tsx": WIDGET,
    "src/App.tsx": "import { memo } from \"react\";\nimport { Widget } from \"./Widget\";\n"
      + "const M = memo(Widget);\n"
      + "export function App() {\n  return <M n={1} />;\n}\n",
  }],
  ["forwardRef", {
    "src/Widget.tsx": "import type { Ref } from \"react\";\n"
      + "export function Widget(props: { n: number }, ref: Ref<HTMLDivElement>) {\n"
      + "  return <div ref={ref}>{props.n}</div>;\n}\n",
    "src/App.tsx": "import { forwardRef } from \"react\";\nimport { Widget } from \"./Widget\";\n"
      + "const F = forwardRef(Widget);\n"
      + "export function App() {\n  return <F n={1} />;\n}\n",
  }],
  ["lazy(() => import(...))", {
    "src/Widget.tsx": WIDGET,
    "src/App.tsx": "import { lazy, Suspense } from \"react\";\n"
      + "const L = lazy(() => import(\"./Widget\"));\n"
      + "export function App() {\n  return <Suspense><L n={1} /></Suspense>;\n}\n",
  }],
  ["an alias, const C = Widget", {
    "src/Widget.tsx": WIDGET,
    "src/App.tsx": "import { Widget } from \"./Widget\";\n"
      + "export function App() {\n  const C = Widget;\n  return <C n={1} />;\n}\n",
  }],
  ["a prop the child renders", {
    "src/Widget.tsx": WIDGET,
    "src/Frame.tsx": "import type { ComponentType } from \"react\";\n"
      + "export function Frame(props: { body: ComponentType<{ n: number }> }) {\n"
      + "  const Body = props.body;\n  return <section><Body n={1} /></section>;\n}\n",
    "src/App.tsx": "import { Frame } from \"./Frame\";\nimport { Widget } from \"./Widget\";\n"
      + "export function App() {\n  return <Frame body={Widget} />;\n}\n",
  }],
  ["an arrow-function component", {
    "src/Widget.tsx": "export const Widget = (props: { n: number }) => <div>{props.n}</div>;\n",
    "src/App.tsx": "import { createElement } from \"react\";\nimport { Widget } from \"./Widget\";\n"
      + "export function App() {\n  return createElement(Widget, { n: 1 });\n}\n",
  }],
  ["a class component", {
    "src/Widget.tsx": "import { Component } from \"react\";\n"
      + "export class Widget extends Component<{ n: number }> {\n"
      + "  render() { return <div>{this.props.n}</div>; }\n}\n",
    "src/App.tsx": "import { createElement } from \"react\";\nimport { Widget } from \"./Widget\";\n"
      + "export function App() {\n  return createElement(Widget, { n: 1 });\n}\n",
  }],
];

describe("App makes Widget, when Widget is a component", () => {
  it.each(SHAPES)("is not called wrong when App renders it by %s", async (_shape, files) => {
    for (const [file, contents] of Object.entries(files)) write(file, contents);
    const board = await boardOf("src/App.tsx#App", "src/Widget.tsx#Widget");

    expect(wrongKind(checkDrift(board, createWorkspace(repo)))?.detail).toBeUndefined();
    expect(wrongKind(refereed(board))?.detail).toBeUndefined();
  });
});

/**
 * What the compiler lets pass as a component is wider than it looks: React's
 * types accept a number or a promise from one, so `parse` and an async loader
 * both compile as `<Parse />`. What rules them out is a string where the props
 * go. A function that takes an object and returns data is ruled out by what
 * it returns.
 */
const NOT_COMPONENTS: Array<[string, string, string]> = [
  ["a parser", "parse", "export function parse(s: string): number {\n  return Number(s);\n}\n"],
  ["an async loader", "load",
    "export async function load(url: string): Promise<number> {\n  return url.length;\n}\n"],
  ["a function returning data", "toRow",
    "export function toRow(o: { a: number }): { a: number } {\n  return o;\n}\n"],
];

describe("App makes a plain function", () => {
  it.each(NOT_COMPONENTS)("is still called wrong for %s: a function is not a type", async (_shape, name, source) => {
    write("src/lib.ts", source);
    write("src/App.tsx", `import { ${name} } from "./lib";\n`
      + `export function App() {\n  return <div>{String(${name})}</div>;\n}\n`);
    const board = await boardOf("src/App.tsx#App", `src/lib.ts#${name}`);

    expect(wrongKind(refereed(board))?.detail).toContain("is not a type");
  });

  it("is left alone with no compiler to say whether it is a component", async () => {
    write("src/lib.ts", NOT_COMPONENTS[0]![2]);
    write("src/App.tsx", "import { parse } from \"./lib\";\n"
      + "export function App() {\n  return <div>{parse(\"1\")}</div>;\n}\n");
    const board = await boardOf("src/App.tsx#App", "src/lib.ts#parse");

    expect(wrongKind(checkDrift(board, createWorkspace(repo)))).toBeUndefined();
  });
});
