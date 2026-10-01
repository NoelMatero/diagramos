/**
 * "This function takes (or returns) a User" is not called wrong when the type
 * is not written on the parameter (#381, #380, #393).
 *
 * `const Button: FC<ButtonProps> = (props) => …` takes `ButtonProps`, and so
 * does `fn run<N: Named>(n: N)` take a `Named`. The checker read the missing
 * or generic type as a missing one. Now the red is put to the compiler first;
 * with no compiler, it rests only on parameters whose types are written out.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, hasRustAnalyzer, redsOf, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

const TS = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"jsx\": \"preserve\", \"target\": \"es2022\" } }\n",
  "fc.ts": [
    "export type FC<P> = (props: P) => unknown;",
    "export interface ButtonProps {\n  label: string;\n}",
    "export interface Req {\n  url: string;\n}",
    "export interface Res {\n  ok: boolean;\n}",
    "export type Handler = (req: Req) => Res;",
    "export class User {}",
    "export class Order {}",
    "",
  ].join("\n"),
};

describe("TypeScript, a parameter typed by something other than its own annotation (#381)", () => {
  it.each([
    ["`const Button: FC<ButtonProps> = (props) => …`", "button.tsx", "import type { FC, ButtonProps } from \"./fc\";\n\nexport const Button: FC<ButtonProps> = (props) => {\n  return <b>{props.label}</b>;\n};\n", "fc.ts#ButtonProps", "button.tsx#Button"],
    ["`const handle: Handler = (req) => …`", "route.ts", "import type { Handler } from \"./fc\";\n\nexport const handle: Handler = (req) => ({ ok: req.url.length > 0 });\n", "fc.ts#Req", "route.ts#handle"],
    ["`const f: (u: User) => Order = (u) => …`", "f.ts", "import { User, Order } from \"./fc\";\n\nexport const f: (u: User) => Order = (u) => new Order();\n", "fc.ts#User", "f.ts#f"],
    ["`function f(u = new User())`", "f.ts", "import { User } from \"./fc\";\n\nexport function f(u = new User()): void {}\n", "fc.ts#User", "f.ts#f"],
  ])("stays quiet on %s", async (_shape, file, source, type, routine) => {
    repo = scratchRepo({ ...TS, [file]: source });
    const { each: [arrow] } = await verdicts(repo, [[type, routine, "takes"]]);
    expect(arrow).toEqual({ reds: [], unconfirmed: "compiler-says-it-does" });
  }, 60_000);

  it("is withheld, not red, with no compiler", async () => {
    repo = scratchRepo({ ...TS, "route.ts": "import type { Handler } from \"./fc\";\n\nexport const handle: Handler = (req) => ({ ok: true });\n" });
    const { each: [arrow] } = await verdicts(repo, [["fc.ts#Req", "route.ts#handle", "takes"]], { compiler: false });
    expect(arrow).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 60_000);

  it("still calls it wrong when the compiler says the parameter is something else", async () => {
    repo = scratchRepo({ ...TS, "route.ts": "import type { Handler } from \"./fc\";\n\nexport const handle: Handler = (req) => ({ ok: true });\n" });
    expect(await redsOf(repo, ["fc.ts#User", "route.ts#handle", "takes"])).toEqual(["signature-absent"]);
  }, 60_000);

  it("is still red with no compiler when every parameter's type is written and none is it", async () => {
    repo = scratchRepo({ ...TS, "f.ts": "import { Order } from \"./fc\";\n\nexport function f(o: Order, n: number): void {}\n" });
    expect(await redsOf(repo, ["fc.ts#User", "f.ts#f", "takes"], { compiler: false })).toEqual(["signature-absent"]);
  }, 60_000);
});

describe("a generic bounded by the type (#380)", () => {
  it.each([
    ["takes", "`function f<T extends User>(u: T): T`"],
    ["returns", "`function f<T extends User>(u: T): T`"],
  ])("TypeScript %s stays quiet on %s", async (word) => {
    repo = scratchRepo({ ...TS, "f.ts": "import { User } from \"./fc\";\n\nexport function f<T extends User>(u: T): T {\n  return u;\n}\n" });
    const { each: [arrow] } = await verdicts(repo, [["fc.ts#User", "f.ts#f", word]]);
    expect(arrow).toEqual({ reds: [], unconfirmed: "compiler-says-it-does" });
  }, 60_000);

  const RUST = {
    "Cargo.toml": "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    "src/lib.rs": "pub mod t;\npub mod f;\n",
    "src/t.rs": "pub trait Named {}\npub struct User;\n",
    "src/f.rs": [
      "use crate::t::{Named, User};",
      "",
      "pub fn generic<N: Named>(n: N) -> N {",
      "    n",
      "}",
      "",
      "pub fn where_clause<N>(n: N) -> N",
      "where",
      "    N: Named,",
      "{",
      "    n",
      "}",
      "",
      "pub fn plain(u: User) -> User {",
      "    u",
      "}",
      "",
    ].join("\n"),
  };

  it("Rust is withheld, not red, with no compiler", async () => {
    repo = scratchRepo(RUST);
    const { each } = await verdicts(repo, [["src/t.rs#Named", "src/f.rs#generic", "takes"], ["src/t.rs#Named", "src/f.rs#where_clause", "takes"]], { compiler: false });
    expect(each).toEqual([{ reds: [], unconfirmed: "rests-on-unwritten" }, { reds: [], unconfirmed: "rests-on-unwritten" }]);
  }, 60_000);

  it("Rust is still red with no compiler when the parameter is written as something else", async () => {
    repo = scratchRepo(RUST);
    expect(await redsOf(repo, ["src/t.rs#Named", "src/f.rs#plain", "takes"], { compiler: false })).toEqual(["signature-absent"]);
  }, 60_000);

  it.skipIf(!hasRustAnalyzer)("Rust is withdrawn when rust-analyzer says `N` is a `Named`, inline and in a where clause", async () => {
    repo = scratchRepo(RUST);
    const { each } = await verdicts(repo, [["src/t.rs#Named", "src/f.rs#generic", "takes"], ["src/t.rs#Named", "src/f.rs#where_clause", "takes"]]);
    expect(each).toEqual([{ reds: [], unconfirmed: "compiler-says-it-does" }, { reds: [], unconfirmed: "compiler-says-it-does" }]);
  }, 180_000);
});
