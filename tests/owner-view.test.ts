/**
 * `owner.ts`'s view of a file, in which a box written `Type::method` is read
 * as that type's own method (fill study, 2026-11).
 *
 * The view renames the name's *other declarations* and nothing else. The
 * first build also renamed every Rust path that writes the name --
 * `DeserializeError::generic(..)` has a `name` field too -- so the call
 * itself vanished from the view and 77 correct calls lost their green in
 * `measure:compiler-true`. A call is never a declaration.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ownerView, pickingOwner } from "../src/engine/owner";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 60_000);

const RUST = [
  "pub struct Error;",
  "pub struct Other;",
  "impl Error {",
  "    pub fn generic(msg: &str) -> Error { Error }",
  "}",
  "impl Other {",
  "    pub fn generic() -> Other { Other }",
  "}",
  "pub fn read(x: u8) -> Result<u8, Error> {",
  "    if x == 0 { return Err(Error::generic(\"zero\")); }",
  "    Ok(x)",
  "}",
  "",
].join("\n");

const changed = (before: string, after: string | undefined) =>
  after === undefined ? [] : before.split("\n").map((line, at) => [line, after.split("\n")[at]] as const)
    .filter(([was, now]) => was !== now).map(([was]) => was.trim());

describe("an owner view", () => {
  it("hides the other type's declaration and keeps the call that writes the owner's path", () => {
    const view = ownerView(RUST, "rust", "generic", "Error");
    expect(view).toBeDefined();
    expect(view!.length).toBe(RUST.length);
    expect(changed(RUST, view)).toEqual(["pub fn generic() -> Other { Other }"]);
  });

  it("has nothing to hide when every declaration of the name is the owner's, however many calls write it", () => {
    const one = RUST.replace("impl Other {\n    pub fn generic() -> Other { Other }\n}\n", "");
    expect(ownerView(one, "rust", "generic", "Error")).toBeUndefined();
  });

  it("keeps the other end's own declaration when both ends are one name in one file", () => {
    // `Client.__init__` calling `BaseClient.__init__` through `super()`: hiding
    // every other `__init__` hid the caller too, and 31 Python and 19
    // TypeScript compiler-true calls lost their green.
    const py = [
      "class BaseClient:", "    def __init__(self):", "        pass", "",
      "class Client(BaseClient):", "    def __init__(self):", "        super().__init__()", "",
      "class Other:", "    def __init__(self):", "        pass", "",
    ].join("\n");
    const view = ownerView(py, "python", "__init__", "BaseClient", ["Client"]);
    expect(changed(py, view)).toEqual(["def __init__(self):"]);
    expect(view!.split("\n")[5]).toBe("    def __init__(self):");
    expect(view!.split("\n")[9]).toBe("    def ________(self):");
  });

  it("hides nothing when no declaration sits under the owner", () => {
    expect(ownerView(RUST, "rust", "generic", "Nowhere")).toBeUndefined();
  });

  it("reads a Python class and a TypeScript class as owners", () => {
    const py = "class A:\n    def run(self):\n        pass\n\nclass B:\n    def run(self):\n        pass\n";
    expect(changed(py, ownerView(py, "python", "run", "A"))).toEqual(["def run(self):"]);
    const ts = "export class A { run(): void {} }\nexport class B { run(): void {} }\nexport function go(a: A) { a.run(); }\n";
    expect(changed(ts, ownerView(ts, "ts", "run", "A"))).toEqual(["export class B { run(): void {} }"]);
  });

  it("does not take a word meaning 'here', or the file's own module, for an owner", () => {
    expect(pickingOwner("Self", "src/a.rs")).toBeUndefined();
    expect(pickingOwner("net", "src/net.rs")).toBeUndefined();
    expect(pickingOwner("Policy", "src/redirect.rs")).toBe("Policy");
  });
});
