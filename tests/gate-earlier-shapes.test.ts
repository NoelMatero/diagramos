/**
 * Correct arrows an earlier fix made quiet stay quiet with the gate in place
 * (#393). The shapes with test files of their own are left to those files:
 * overridden methods (#353, `calls-overridden-method`), a function passed as
 * a value (#359, `calls-passed-as-value`), a React component (#363,
 * `builds-component`), a tuple struct (#371, `holds-unit-struct`), an arrow
 * into a class (#392, `calls-into-a-class`). Here: #366 section 2's, a call
 * through a table or a decorator's registry, which reaches a function its
 * text never names.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, redsOf, scratchRepo } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

describe("#366 section 2: a call that picks its target at run time", () => {
  it("Python: a decorator's registry, dispatched by name", async () => {
    repo = scratchRepo({
      "handlers.py": [
        "HANDLERS = {}",
        "",
        "",
        "def register(fn):",
        "    HANDLERS[fn.__name__] = fn",
        "    return fn",
        "",
        "",
        "@register",
        "def greet():",
        "    return 'hi'",
        "",
      ].join("\n"),
      "dispatch.py": "from handlers import HANDLERS\n\n\ndef dispatch(name):\n    return HANDLERS[name]()\n",
    });
    expect(await redsOf(repo, ["dispatch.py#dispatch", "handlers.py#greet", "calls"])).toEqual([]);
  }, 120_000);

  it("TypeScript: `obj[name]()`", async () => {
    repo = scratchRepo({
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
      "transforms.ts": "export function bind(): number {\n  return 1;\n}\n\nexport const transforms: Record<string, () => number> = { bind };\n",
      "props.ts": "import { transforms } from \"./transforms\";\n\nexport function build(name: string): number {\n  return transforms[name]!();\n}\n",
    });
    expect(await redsOf(repo, ["props.ts#build", "transforms.ts#bind", "calls"])).toEqual([]);
  }, 60_000);
});
