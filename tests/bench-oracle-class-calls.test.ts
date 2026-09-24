/**
 * #346: what the answer key says about an `@calls` arrow drawn out of a class.
 *
 * A board that says "Installer calls report" means some routine of Installer
 * does. The key used to call every such arrow false -- "only something that
 * runs can call" -- so a checker that confirmed a true one was scored as
 * agreeing with a mistake, and a checker that refuted a false one could not be
 * told apart from one refuting a true one.
 *
 * Asked of the real tools, per language, because each one finds a type's
 * routines differently: TypeScript and Python inside the class, Rust in `impl`
 * blocks anywhere in the crate.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOracle, type Oracle } from "../scripts/lib/bench-oracle";
import { createTooling, type Language } from "../scripts/lib/bench-tooling";

/** A language server's round trip under a loaded suite; see resolution-rust-lsp.test.ts. */
const LIVE_TIMEOUT_MS = 60_000;

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "class-calls-"));
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

function oracleOver(language: Language, files: Record<string, string>) {
  let root = "";
  let oracle: Oracle | undefined;
  beforeAll(async () => {
    root = tree(files);
    oracle = createOracle(await createTooling(language, root));
  }, LIVE_TIMEOUT_MS);
  afterAll(() => {
    oracle?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  return (from: string, to: string) => oracle!.judge({ word: "calls", from, to });
}

describe("TypeScript: a class calls what one of its routines calls", () => {
  const judge = oracleOver("ts", {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }),
    "report.ts": "export function report(message: string): void { console.log(message); }\n"
      + "export function build(): number { return 1; }\n",
    "installer.ts": [
      'import { report, build } from "./report";',
      "export class Installer {",
      "  install(): void { report(\"installing\"); }",
      "}",
      "export class Holder {",
      "  made = build();",
      "}",
      "export class Quiet {",
      "  tidy(): number { return 1; }",
      "}",
      "export class Base {",
      "  announce(): void { report(\"base\"); }",
      "}",
      "export class Child extends Base {",
      "  tidy(): number { return 2; }",
      "}",
      "",
    ].join("\n"),
  });

  it("is true when a method calls it", async () => {
    expect(await judge("installer.ts#Installer", "report.ts#report"))
      .toEqual({ truth: "true", why: "its routine install calls it" });
  }, LIVE_TIMEOUT_MS);

  it("is true when a field's initialiser calls it", async () => {
    expect(await judge("installer.ts#Holder", "report.ts#build"))
      .toEqual({ truth: "true", why: "code inside the type calls it" });
  }, LIVE_TIMEOUT_MS);

  it("stays false when every method was read and none calls it", async () => {
    expect(await judge("installer.ts#Quiet", "report.ts#report"))
      .toEqual({ truth: "false", why: "every routine of the type was read and none calls it" });
  }, LIVE_TIMEOUT_MS);

  it("will not say false when a base in the repository may be the one calling", async () => {
    const answer = await judge("installer.ts#Child", "report.ts#report");
    expect(answer.truth).toBe("undecidable");
    expect(answer.why).toMatch(/inherits from Base/);
  }, LIVE_TIMEOUT_MS);
});

describe("Python: a class calls what one of its routines calls", () => {
  const judge = oracleOver("python", {
    "report.py": "def report(message: str) -> None:\n    print(message)\n\n\ndef build() -> int:\n    return 1\n",
    "installer.py": [
      "from report import report, build",
      "",
      "",
      "class Installer:",
      "    def install(self) -> None:",
      "        report(\"installing\")",
      "",
      "",
      "class Holder:",
      "    made = build()",
      "",
      "",
      "class Quiet:",
      "    def tidy(self) -> int:",
      "        return 1",
      "",
      "",
      "class Base:",
      "    def announce(self) -> None:",
      "        report(\"base\")",
      "",
      "",
      "class Child(Base):",
      "    def tidy(self) -> int:",
      "        return 2",
      "",
    ].join("\n"),
  });

  it("is true when a method calls it", async () => {
    expect(await judge("installer.py#Installer", "report.py#report"))
      .toEqual({ truth: "true", why: "its routine install calls it" });
  }, LIVE_TIMEOUT_MS);

  it("is true when the class body calls it", async () => {
    expect(await judge("installer.py#Holder", "report.py#build"))
      .toEqual({ truth: "true", why: "code inside the type calls it" });
  }, LIVE_TIMEOUT_MS);

  it("stays false when every method was read and none calls it", async () => {
    expect(await judge("installer.py#Quiet", "report.py#report"))
      .toEqual({ truth: "false", why: "every routine of the type was read and none calls it" });
  }, LIVE_TIMEOUT_MS);

  it("will not say false when a base in the repository may be the one calling", async () => {
    const answer = await judge("installer.py#Child", "report.py#report");
    expect(answer.truth).toBe("undecidable");
    expect(answer.why).toMatch(/inherits from Base/);
  }, LIVE_TIMEOUT_MS);
});

describe.skipIf(!hasRustAnalyzer)("Rust: a type calls what a routine in one of its impl blocks calls", () => {
  const judge = oracleOver("rust", {
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\npath = \"src/lib.rs\"\n",
    "src/lib.rs": "pub mod report;\npub mod installer;\npub mod installing;\n",
    "src/report.rs": "pub fn report(message: &str) { println!(\"{}\", message); }\n",
    "src/installer.rs": [
      "pub struct Installer;",
      "pub struct Quiet;",
      "impl Quiet {",
      "    pub fn tidy(&self) -> u32 { 1 }",
      "}",
      "pub trait Announce {",
      "    fn announce(&self) { crate::report::report(\"default\"); }",
      "}",
      "pub struct Loud;",
      "impl Announce for Loud {}",
      "",
    ].join("\n"),
    // The impl in another module from the type it is for, which is where a
    // reader that only looks beside the declaration would find nothing.
    "src/installing.rs": [
      "use crate::installer::Installer;",
      "use crate::report::report;",
      "impl Installer {",
      "    pub fn install(&self) { report(\"installing\"); }",
      "}",
      "",
    ].join("\n"),
  });

  it("is true when a method in an impl block in another file calls it", async () => {
    expect(await judge("src/installer.rs#Installer", "src/report.rs#report"))
      .toEqual({ truth: "true", why: "its routine install calls it" });
  }, LIVE_TIMEOUT_MS);

  it("stays false when every method was read and none calls it", async () => {
    expect(await judge("src/installer.rs#Quiet", "src/report.rs#report"))
      .toEqual({ truth: "false", why: "every routine of the type was read and none calls it" });
  }, LIVE_TIMEOUT_MS);

  it("will not say false when a trait's default method may be the one calling", async () => {
    const answer = await judge("src/installer.rs#Loud", "src/report.rs#report");
    expect(answer.truth).toBe("undecidable");
    expect(answer.why).toMatch(/implements Announce/);
  }, LIVE_TIMEOUT_MS);
});
