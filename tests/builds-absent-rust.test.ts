/**
 * `@builds` on a Rust board may say "A doesn't create B" (#362).
 *
 * The bad outcome: clap's `_build -> MKeyMap` says `_build` makes a key map.
 * It fills one it was handed; it creates none. Nothing said so.
 *
 * The risk is a correct arrow called wrong, and Rust has a way to create a B
 * that never writes its name: `x.clone()`, `x.into()`, a type alias, `Self`.
 * #360 found about 17 real functions in the corpus the text reader alone
 * would have accused. So the accusation also needs rustc's own body for the
 * routine (`--emit=mir`) to show no B written and no call handing one back,
 * and a routine rustc did not compile -- a binary target, a `cfg` -- is
 * never accused.
 *
 * One crate, one board, one build for the lot. Needs `cargo`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const HAS_CARGO = spawnSync("cargo", ["--version"]).status === 0;
const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

const FILES: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "makes"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nextra = []\n',
  "src/lib.rs": "pub mod widget;\npub mod makers;\npub mod indexes;\n",
  "src/widget.rs": [
    "#[derive(Clone, Default, Debug)]\npub struct Widget {\n    pub x: u8,\n}",
    "pub struct Gear {\n    pub teeth: u8,\n}",
    "pub struct Key {\n    pub name: u8,\n}",
    "pub struct Tagged(pub u8);",
    "impl From<u8> for Widget {\n    fn from(x: u8) -> Widget {\n        Widget { x }\n    }\n}",
    "pub struct KeyMap {\n    pub keys: Vec<Key>,\n}",
    "impl KeyMap {\n    pub fn _build(&mut self) {\n        self.keys.push(Key { name: 1 });\n    }\n}",
    "impl Widget {\n    pub fn new() -> Self {\n        Self { x: 0 }\n    }\n"
      + "    pub fn reset(&mut self) {\n        *self = Self { x: 0 };\n    }\n"
      + "    pub fn renew(&mut self) {\n        *self = Self::new();\n    }\n}",
    "impl Tagged {\n    pub fn reset_tag(&mut self) {\n        *self = Self(0);\n    }\n}",
    "pub struct Holder {\n    pub first: Widget,\n    pub raw: u8,\n    pub all: Vec<Widget>,\n}",
    "",
  ].join("\n\n"),
  "src/makers.rs": [
    "use crate::widget::{Gear, Holder, Widget};",
    "use crate::widget::Widget as Gadget;",
    "type Maker = Widget;",
    "pub fn gear() -> u8 {\n    let g = Gear { teeth: 3 };\n    g.teeth\n}",
    "pub fn nothing() -> u8 {\n    1\n}",
    "pub fn by_default() -> u8 {\n    Widget::default().x\n}",
    "pub fn by_from() -> u8 {\n    Widget::from(1u8).x\n}",
    "pub fn typed_into(x: u8) -> u8 {\n    let w: Widget = x.into();\n    w.x\n}",
    "pub fn pushed(v: &mut Vec<Widget>) {\n    v.push(Default::default());\n}",
    "pub fn collected(xs: &[u8]) -> usize {\n    xs.iter().map(|&x| x.into()).collect::<Vec<Widget>>().len()\n}",
    "pub fn cloned(h: &Holder) -> u8 {\n    let c = h.first.clone();\n    c.x\n}",
    "pub fn converted(h: &mut Holder) {\n    h.all.push(h.raw.into());\n}",
    "pub fn aliased() -> u8 {\n    Maker { x: 0 }.x\n}",
    "pub fn renamed() -> u8 {\n    Gadget { x: 0 }.x\n}",
    "pub fn switched(h: &Holder) -> u8 {\n    #[cfg(feature = \"extra\")]\n    {\n        return h.first.clone().x;\n    }\n    h.raw\n}",
    "macro_rules! make {\n    () => {\n        crate::widget::Widget { x: 0 }\n    };\n}",
    "pub fn by_macro() -> u8 {\n    make!().x\n}",
    "pub trait Fresh: Default {\n    fn fresh() -> Self {\n        Self::default()\n    }\n}",
    "",
  ].join("\n\n"),
  "src/indexes.rs": [
    "pub struct Index(pub u8);",
    "impl Index {\n    pub fn new(x: u8) -> Index {\n        Index(x)\n    }\n}",
    "pub struct IndexIter {\n    pub at: u8,\n}",
    "macro_rules! iter_for {\n    ($name:ident) => {\n        pub struct $name(pub IndexIter);\n\n"
      + "        impl $name {\n            pub fn new() -> $name {\n                $name(IndexIter { at: 0 })\n            }\n        }\n    };\n}",
    "iter_for!(PatternIter);",
    "",
  ].join("\n\n"),
  "src/main.rs": "fn run() -> u8 {\n    1\n}\n\nfn main() {\n    println!(\"{}\", run());\n}\n",
};

const W = "src/widget.rs#";
const M = "src/makers.rs#";

let repo: string;
let cache: string;
const previousCache = process.env.DIAGRAMOS_RUSTC_CACHE;

/** Every arrow drawn as `@builds`, checked once with rustc's bodies; the accused ones, by their refs. */
async function accused(arrows: Array<[string, string]>, state?: "planned"): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const id = (ref: string) => {
    if (!ids.has(ref)) ids.set(ref, `n${ids.size}`);
    return ids.get(ref)!;
  };
  const edges = arrows.map(([from, to]) => ({
    from: id(from), to: id(to), claim: "builds" as const, ...(state ? { state } : {}),
  }));
  const { board } = await createDiagram(emptyBoard(), {
    name: "makes",
    nodes: [...ids].map(([ref, one]) => ({ id: one, label: ref.split("#")[1]!, ref })),
    edges,
  });
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  const byId = new Map([...ids].map(([ref, one]) => [one, ref]));
  return new Map(live.report.edges
    .filter((finding) => ACCUSES.has(finding.kind))
    .map((finding) => {
      const [from, to] = (finding as { node: string }).node.split(" -> ");
      return [`${byId.get(from!)} -> ${byId.get(to!)}`, `${finding.kind}: ${finding.detail}`];
    }));
}

beforeAll(async () => {
  await initEngine();
  cache = mkdtempSync(path.join(tmpdir(), "rustc-cache-"));
  process.env.DIAGRAMOS_RUSTC_CACHE = cache;
  repo = mkdtempSync(path.join(tmpdir(), "builds-rust-"));
  for (const [relative, contents] of Object.entries(FILES)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}, 60_000);

afterAll(() => {
  if (previousCache === undefined) delete process.env.DIAGRAMOS_RUSTC_CACHE;
  else process.env.DIAGRAMOS_RUSTC_CACHE = previousCache;
  rmSync(cache, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!HAS_CARGO)("Rust: a routine that creates something else", () => {
  it("is red on a method that fills the map it was handed (clap's _build -> MKeyMap)", async () => {
    const red = await accused([[`${W}_build`, `${W}KeyMap`]]);
    expect(red.get(`${W}_build -> ${W}KeyMap`)).toMatch(/^builds-refuted: .*it creates Key instead/);
  }, 240_000);

  it("is red on a routine that creates a different struct, and on one that creates nothing", async () => {
    const red = await accused([[`${M}gear`, `${W}Widget`], [`${M}nothing`, `${W}Widget`]]);
    expect(red.get(`${M}gear -> ${W}Widget`)).toMatch(/^builds-refuted: .*it creates Gear instead/);
    expect(red.get(`${M}nothing -> ${W}Widget`)).toMatch(/^builds-refuted: .*own code never creates one\. Getting/);
  }, 240_000);
});

/** Correct arrows, each a way a Rust body creates a Widget without writing `Widget { .. }`. */
const RIGHT: Array<[string, string, string]> = [
  ["`Self { .. }` in the type's own impl", `${W}reset`, `${W}Widget`],
  ["`Self::new()` in the type's own impl", `${W}renew`, `${W}Widget`],
  ["`Self(..)` for a tuple struct", `${W}reset_tag`, `${W}Tagged`],
  ["`Widget::default()`", `${M}by_default`, `${W}Widget`],
  ["`Widget::from(..)`", `${M}by_from`, `${W}Widget`],
  ["`let w: Widget = x.into()`", `${M}typed_into`, `${W}Widget`],
  ["`Default::default()` pushed into a `Vec<Widget>`", `${M}pushed`, `${W}Widget`],
  ["`.collect::<Vec<Widget>>()`", `${M}collected`, `${W}Widget`],
  ["an unnamed `.clone()` of a Widget", `${M}cloned`, `${W}Widget`],
  ["an unnamed `.into()` into a Widget", `${M}converted`, `${W}Widget`],
  ["a type alias, `type Maker = Widget`", `${M}aliased`, `${W}Widget`],
  ["`use Widget as Gadget`", `${M}renamed`, `${W}Widget`],
  ["a construction only a `cfg` feature compiles", `${M}switched`, `${W}Widget`],
  ["a construction inside a macro", `${M}by_macro`, `${W}Widget`],
  ["`Self::default()` in a trait's default method", `${M}fresh`, `${W}Widget`],
  ["a binary target, which the library build never compiles", "src/main.rs#run", `${W}Widget`],
  /*
   * regex's `primitives.rs`: a macro in the file generates a `fn new` that
   * creates the iterator, and the only `fn new` the text can see creates
   * something else. The arrow may mean the generated one.
   */
  ["a `fn new` a macro in the same file generates", "src/indexes.rs#new", "src/indexes.rs#IndexIter"],
];

describe.skipIf(!HAS_CARGO)("Rust: correct arrows stay quiet", () => {
  let red: Map<string, string>;
  beforeAll(async () => {
    red = await accused(RIGHT.map(([, from, to]) => [from, to]));
  }, 240_000);

  for (const [shape, from, to] of RIGHT) {
    it(`stays quiet on ${shape}`, () => {
      expect(red.get(`${from} -> ${to}`)).toBeUndefined();
    });
  }

  it("stays quiet on a planned arrow", async () => {
    const planned = await accused([[`${M}nothing`, `${W}Widget`]], "planned");
    expect([...planned.keys()]).toEqual([]);
  }, 240_000);
});
