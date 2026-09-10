/**
 * A method call on a local value, where the same file happens to declare a
 * routine of the method's name (#254).
 *
 * `seen.add(x)` calls `Set.prototype.add`. It says nothing about an `add` this
 * file declares itself -- but `resolves` returned `yes` for it, because it
 * checked "the target is this same file" **before** checking whether the call
 * was written on a receiver at all. `placeOf`, the same branches in the same
 * order by its own doc, asks in the other order and is right.
 *
 * Found by `measure:calls`' checker referee, which put six of these to a real
 * compiler and got a standard-library method back every time: `Set.add` and
 * `Response.json` in this repository, `Path::parent`, `Command::arg` and
 * `Read::read_to_end` in ripgrep.
 *
 * Both directions are tested, because they cost different things. Forward is a
 * green nothing earned. Reverse is `backwards` -- a red on an arrow whose two
 * ends are the same file, which is the one shape where this is reachable.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { initEngine, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

function ask(
  file: string, source: string, language: Language,
  from: { routine: string }, to: { names: string[] },
): CallsVerdict {
  const side: CallSide = { file, source, language, imports: [] };
  return callsBetween({ ...side, routine: from.routine }, { ...side, names: to.names });
}

/** The real shape, from `src/engine/rust.ts`: a local `add`, and a `Set`. */
const TS_SET = "export function collect(): string[] {\n"
  + "  const add = (file: string): void => { out.push(file); };\n"
  + "  return [];\n"
  + "}\n"
  + "export function resolveRustPath(files: string[]): string[] {\n"
  + "  const seen = new Set<string>();\n"
  + "  for (const file of files) seen.add(file);\n"
  + "  return [...seen];\n"
  + "}\n";

describe("a receiver call whose method name this file also declares", () => {
  it("does not confirm `seen.add(x)` as a call to this file's own `add`", () => {
    const verdict = ask("src/rust.ts", TS_SET, "ts", { routine: "resolveRustPath" }, { names: ["add"] });
    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("receiver");
  });

  it("does not say `backwards` on the strength of one, which would be a red", () => {
    const verdict = ask("src/rust.ts", TS_SET, "ts", { routine: "add" }, { names: ["resolveRustPath"] });
    expect(verdict.verdict).not.toBe("backwards");
  });

  it("does not confirm `await response.json()` as a call to this file's own `json`", () => {
    const source = "function json(status: number): void {}\n"
      + "async function probeBoard(url: string): Promise<unknown> {\n"
      + "  const response = await fetch(url);\n"
      + "  return await response.json();\n"
      + "}\n";
    const verdict = ask("src/server.ts", source, "ts", { routine: "probeBoard" }, { names: ["json"] });
    expect(verdict.verdict).toBe("withheld");
  });

  it("does not confirm `path.parent()` as a call to this file's own `parent`, in Rust", () => {
    const source = "pub fn parent(dir: &Path) -> bool { true }\n\n"
      + "pub fn add_parents(path: &Path) {\n"
      + "    let p = path.to_path_buf();\n"
      + "    if let Some(one) = p.parent() { let _ = one; }\n"
      + "}\n";
    const verdict = ask("src/dir.rs", source, "rust", { routine: "add_parents" }, { names: ["parent"] });
    expect(verdict.verdict).toBe("withheld");
  });

  it("does not confirm `self.cache.foo()` as a call to this file's own `foo`, in Python", () => {
    const source = "def foo():\n    return 1\n\n\nclass Holder:\n"
      + "    def run(self):\n        return self.cache.foo()\n";
    const verdict = ask("app/holder.py", source, "python", { routine: "run" }, { names: ["foo"] });
    expect(verdict.verdict).toBe("withheld");
  });

  it("still confirms a bare same-file call, which is what the branch was for", () => {
    const source = "function add(file: string): void {}\n"
      + "export function collect(files: string[]): void {\n  for (const file of files) add(file);\n}\n";
    const verdict = ask("src/rust.ts", source, "ts", { routine: "collect" }, { names: ["add"] });
    expect(verdict.verdict).toBe("confirmed");
  });

  it("still confirms a call on `this`, which is this file's own by definition", () => {
    const source = "class Board {\n  add(file: string): void {}\n"
      + "  collect(files: string[]): void { for (const file of files) this.add(file); }\n}\n";
    const verdict = ask("src/board.ts", source, "ts", { routine: "collect" }, { names: ["add"] });
    expect(verdict.verdict).toBe("confirmed");
  });
});
