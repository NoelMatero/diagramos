/**
 * A wrong arrow the compiler can settle is settled, and a red it cannot is
 * withdrawn with the question it could not answer (#416).
 *
 * #410 read the 14 bench arrows withdrawn as "the code does not write down
 * the one thing this depends on": in 13 the thing was written. A compiler
 * had been asked and its answer was lost -- never sent, sent and refused, or
 * sent and read wrong. Each shape the arrows shared is pinned here, with the
 * wording a withdrawn red now carries.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine, parseSource } from "../src/engine/parse";
import { typeParametersIn } from "../src/engine/gate";
import { dropRepo, redsOf, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

describe("a question that only comes up once another is answered", () => {
  /*
   * flask's `open_instance_resource`: the body's calls close only once "go
   * to definition" places `os.path.join` and `open`, and the red that then
   * stands asks what `request_context` is on each value handed to them. One
   * recording round never saw that question, so pyright was never asked.
   */
  const FLASK = {
    "app.py": [
      "import os",
      "",
      "",
      "class App:",
      "    def request_context(self) -> None:",
      "        return None",
      "",
      "    def open_resource(self, resource: str, mode: str = \"rb\"):",
      "        path = os.path.join(\"static\", resource)",
      "        return open(path, mode)",
      "",
    ].join("\n"),
  };

  it("is asked, and a wrong arrow goes red", async () => {
    repo = scratchRepo(FLASK);
    expect(await redsOf(repo, ["app.py#open_resource", "app.py#request_context", "calls"])).toEqual(["calls-refuted"]);
  }, 120_000);
});

describe("a call on a local whose type comes from a typed return", () => {
  it.each([
    ["Python", {
      "ctx.py": "class AppContext:\n    def push(self) -> None:\n        pass\n",
      "app.py": [
        "from ctx import AppContext",
        "",
        "",
        "class App:",
        "    def request_context(self) -> AppContext:",
        "        return AppContext()",
        "",
        "    def wsgi_app(self) -> None:",
        "        ctx = self.request_context()",
        "        ctx.push()",
        "",
      ].join("\n"),
    }, "app.py#wsgi_app", "ctx.py#push"],
    ["TypeScript", {
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
      "ctx.ts": "export class AppContext {\n  push(): void {}\n}\n",
      "app.ts": [
        "import { AppContext } from \"./ctx\";",
        "",
        "export class App {",
        "  requestContext(): AppContext {",
        "    return new AppContext();",
        "  }",
        "",
        "  wsgiApp(): void {",
        "    const ctx = this.requestContext();",
        "    ctx.push();",
        "  }",
        "}",
        "",
      ].join("\n"),
    }, "app.ts#wsgiApp", "ctx.ts#push"],
  ])("%s: is confirmed on the compiler's \"go to definition\"", async (_language, files, from, to) => {
    repo = scratchRepo(files);
    const { each: [arrow] } = await verdicts(repo, [[from, to, "calls"]]);
    expect(arrow).toEqual({ reds: [] });
  }, 120_000);

  it("is still not confirmed when the call lands on a method of that name in another file", async () => {
    repo = scratchRepo({
      "ctx.py": "class AppContext:\n    def push(self) -> None:\n        pass\n",
      "other.py": "class Other:\n    def push(self) -> None:\n        pass\n",
      "app.py": "from other import Other\n\n\ndef run() -> None:\n    ctx = Other()\n    ctx.push()\n",
    });
    const { each: [arrow] } = await verdicts(repo, [["app.py#run", "ctx.py#push", "calls"]]);
    expect(arrow!.unconfirmed).toBeDefined();
  }, 120_000);
});

describe("Python types written in brackets are written", () => {
  it("does not take `dict[str, Any]` for a type parameter, and still finds `class A[T]`'s", () => {
    const names = (source: string) => [...typeParametersIn(parseSource(source, "python")!.rootNode, source)];
    expect(names("def f(x: dict[str, int], y: str) -> list[str]: ...\n")).toEqual([]);
    expect(names("class A[T]:\n    def f[U](self, x: list[U]) -> dict[str, T]: ...\n")).toEqual(["T", "U"]);
    expect(names("type Pair[K] = dict[K, int]\n")).toEqual(["K"]);
  });

  it("calls a signature wrong that writes every type and names none of it, with no compiler", async () => {
    // pydantic's `ConfigWrapper.__init__(self, config: ConfigDict | dict[str, Any] | type[Any] | None)`.
    repo = scratchRepo({
      "model.py": "class Engine:\n    pass\n",
      "config.py": "from typing import Any\n\n\nclass Wrapper:\n    def __init__(self, config: dict[str, Any] | None, name: str) -> None:\n        self.config = config\n",
    });
    expect(await redsOf(repo, ["model.py#Engine", "config.py#Wrapper", "takes"], { compiler: false })).toEqual(["signature-absent"]);
  }, 60_000);
});

describe("an alias pyright prints by its name", () => {
  // httpx's `params: QueryParamTypes | None`, where the alias is a union of written types.
  const HTTPX = {
    "model.py": "class Engine:\n    pass\n",
    "types_.py": "from typing import Any, Mapping, Union\n\nPrimitive = Union[str, int, None]\nParams = Union[Mapping[str, Primitive], str, bytes]\nData = Mapping[str, Any]\n",
    "request.py": "from types_ import Data, Params\n\n\nclass Request:\n    def __init__(self, params: Params | None = None, data: Data | None = None) -> None:\n        self.params = params\n",
  };

  it("is opened, and a wrong arrow goes red", async () => {
    repo = scratchRepo(HTTPX);
    expect(await redsOf(repo, ["model.py#Engine", "request.py#Request", "takes"])).toEqual(["signature-absent"]);
  }, 120_000);

  it("still confirms an arrow to a type the alias stands for", async () => {
    repo = scratchRepo({
      ...HTTPX,
      "types_.py": "from typing import Mapping, Union\nfrom model import Engine\n\nParams = Union[Mapping[str, str], Engine]\nData = str\n",
    });
    const { each: [arrow] } = await verdicts(repo, [["model.py#Engine", "request.py#Request", "takes"]]);
    expect(arrow!.reds).toEqual([]);
  }, 120_000);
});

describe("TypeScript classes with type parameters, and whether one fits another", () => {
  const VUE = {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
    "dep.ts": "export class Dep {\n  version = 0;\n  track(): void {}\n}\n",
    "effect.ts": "export class ReactiveEffect<T = any> {\n  constructor(public fn: () => T) {}\n  run(): T {\n    return this.fn();\n  }\n}\n",
    "computed.ts": [
      "import { Dep } from \"./dep\";",
      "",
      "export class ComputedRefImpl<T = any> {",
      "  dep: Dep = new Dep();",
      "  constructor(public fn: () => T) {}",
      "  get value(): T {",
      "    return this.fn();",
      "  }",
      "}",
      "",
    ].join("\n"),
    "box.ts": "export class Box<T> {\n  constructor(public fn: () => T) {}\n  run(): T {\n    return this.fn();\n  }\n}\n",
  };

  it("calls one wrong that lacks a member the other requires, whatever its type arguments", async () => {
    repo = scratchRepo(VUE);
    expect(await redsOf(repo, ["effect.ts#ReactiveEffect", "computed.ts#ComputedRefImpl", "conforms"])).toEqual(["conforms-absent"]);
  }, 60_000);

  it("withholds one that has every member, since its type arguments decide", async () => {
    repo = scratchRepo(VUE);
    expect(await redsOf(repo, ["box.ts#Box", "effect.ts#ReactiveEffect", "conforms"])).toEqual([]);
  }, 60_000);
});

describe("a package the clone has not installed", () => {
  it("TypeScript: a sibling workspace package is found where npm would link it", async () => {
    repo = scratchRepo({
      "package.json": "{ \"name\": \"root\", \"private\": true, \"workspaces\": [\"packages/*\"] }\n",
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\", \"module\": \"nodenext\", \"moduleResolution\": \"nodenext\" } }\n",
      "packages/core/package.json": "{ \"name\": \"@acme/core\", \"type\": \"module\", \"exports\": { \".\": \"./src/index.ts\" } }\n",
      "packages/core/src/index.ts": "export function double(x: number): number {\n  return x * 2;\n}\n",
      "packages/app/package.json": "{ \"name\": \"@acme/app\", \"type\": \"module\" }\n",
      "packages/app/src/main.ts": "import { double } from \"@acme/core\";\n\nexport function run(): number {\n  return double(1);\n}\n",
      "packages/app/src/other.ts": "export function other(): number {\n  return 1;\n}\n",
    });
    expect(await redsOf(repo, ["packages/app/src/main.ts", "packages/app/src/other.ts", "needs"])).toEqual(["needs-absent"]);
  }, 60_000);

  it("Python: a module no file here could be is a library's", async () => {
    // poetry's `poetry.core.packages.package`: the separate poetry-core, not installed.
    repo = scratchRepo({
      "pkg/__init__.py": "",
      "pkg/a.py": "from pkg.core.packages import Package\n\n\ndef make() -> Package:\n    return Package()\n",
      "pkg/b.py": "def other() -> int:\n    return 1\n",
    });
    expect(await redsOf(repo, ["pkg/a.py", "pkg/b.py", "needs"])).toEqual(["needs-absent"]);
  }, 120_000);
});

describe("a red the compiler could not settle says what it asked", () => {
  it("names the type parameter it found, and not a type to go and write", async () => {
    // nest's `DefaultValuePipe<T = any, R = any>`'s `constructor(defaultValue: R)`.
    repo = scratchRepo({
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
      "meta.ts": "export interface ArgumentMetadata {\n  type: string;\n}\n",
      "pipe.ts": "export class DefaultValuePipe<T = any, R = any> {\n  constructor(protected readonly defaultValue: R) {}\n}\n",
    });
    const { report } = await verdicts(repo, [["meta.ts#ArgumentMetadata", "pipe.ts#DefaultValuePipe", "takes"]]);
    const [arrow] = report.unconfirmedEdges;
    expect(arrow?.reason).toBe("compiler-could-not-say");
    expect(arrow?.detail).toContain("the compiler says `defaultValue` is a type parameter, `any` or `unknown`");
    expect(arrow?.detail).not.toContain("does not write down");
  }, 60_000);

  it("keeps \"not written down\" for a check that had no compiler", async () => {
    repo = scratchRepo({
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
      "meta.ts": "export interface ArgumentMetadata {\n  type: string;\n}\n",
      "pipe.ts": "export class DefaultValuePipe<T = any, R = any> {\n  constructor(protected readonly defaultValue: R) {}\n}\n",
    });
    const { report } = await verdicts(repo, [["meta.ts#ArgumentMetadata", "pipe.ts#DefaultValuePipe", "takes"]], { compiler: false });
    const [arrow] = report.unconfirmedEdges;
    expect(arrow?.reason).toBe("rests-on-unwritten");
    expect(arrow?.detail).toContain("no compiler was running to check it");
  }, 60_000);
});
