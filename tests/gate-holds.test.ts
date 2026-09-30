/**
 * "A field of Car holds Engine" is not called wrong when the field's type is
 * not written (#378, #380, #393).
 *
 * `self.engine = Engine()`, `engine = new Engine()` and `seat: S` with
 * `S: Seat` all hold what the arrow says, and the checker used to read the
 * missing type as a missing field. Now the red is put to the compiler first:
 * it says what the field's type is. With no compiler, a red rests only on a
 * field list that is written out in full.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, hasRustAnalyzer, redsOf, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

const TS = { "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n", "engine.ts": "export class Engine {}\nexport class Motor {}\n" };

describe("TypeScript, a field with no written type", () => {
  it("stays quiet on `engine = new Engine()`", async () => {
    repo = scratchRepo({ ...TS, "car.ts": "import { Engine } from \"./engine\";\n\nexport class Car {\n  engine = new Engine();\n}\n" });
    const { each: [car] } = await verdicts(repo, [["car.ts#Car", "engine.ts#Engine", "holds"]]);
    expect(car).toEqual({ reds: [], unconfirmed: "compiler-says-it-does" });
  }, 60_000);

  it("is withheld, not red, with no compiler", async () => {
    repo = scratchRepo({ ...TS, "car.ts": "import { Engine } from \"./engine\";\n\nexport class Car {\n  engine = new Engine();\n}\n" });
    const { each: [car] } = await verdicts(repo, [["car.ts#Car", "engine.ts#Engine", "holds"]], { compiler: false });
    expect(car).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 60_000);

  it("still calls it wrong when the compiler says the field is something else", async () => {
    repo = scratchRepo({ ...TS, "car.ts": "import { Motor } from \"./engine\";\n\nexport class Car {\n  engine = new Motor();\n}\n" });
    expect(await redsOf(repo, ["car.ts#Car", "engine.ts#Engine", "holds"])).toEqual(["holds-absent"]);
  }, 60_000);
});

describe("TypeScript, the other shapes #378 found", () => {
  it.each([
    ["`speed = 0; engine = new Engine();`", "  speed = 0;\n  engine = new Engine();\n"],
    ["a typed field beside `engine = new Engine()`", "  wheels: number = 4;\n  engine = new Engine();\n"],
    ["`engine;` assigned in the constructor", "  engine;\n  constructor() {\n    this.engine = new Engine();\n  }\n"],
  ])("stays quiet on %s", async (_shape, body) => {
    repo = scratchRepo({ ...TS, "car.ts": `import { Engine } from "./engine";\n\nexport class Car {\n${body}}\n` });
    expect(await redsOf(repo, ["car.ts#Car", "engine.ts#Engine", "holds"])).toEqual([]);
  }, 60_000);
});

describe("the guard: a field list written out in full", () => {
  it("is still red with no compiler when every field names something else", async () => {
    repo = scratchRepo({ ...TS, "car.ts": "import { Motor } from \"./engine\";\n\nexport class Car {\n  engine: Motor = new Motor();\n  speed: number = 0;\n}\n" });
    expect(await redsOf(repo, ["car.ts#Car", "engine.ts#Engine", "holds"], { compiler: false })).toEqual(["holds-absent"]);
  }, 60_000);
});

const RUST = {
  "Cargo.toml": "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
  "src/lib.rs": "pub mod parts;\npub mod car;\n",
  "src/parts.rs": "pub struct Engine;\npub trait Seat {}\npub trait Wheel {}\n",
};

describe("Rust, a field whose type is a type parameter (#380)", () => {
  const car = "use crate::parts::{Engine, Seat};\n\npub struct Gen<S: Seat> {\n    seat: S,\n    engine: Engine,\n}\n";

  it("is withheld, not red, with no compiler: `S` is written, what it stands for is not", async () => {
    repo = scratchRepo({ ...RUST, "src/car.rs": car });
    const { each: [gen] } = await verdicts(repo, [["src/car.rs#Gen", "src/parts.rs#Seat", "holds"]], { compiler: false });
    expect(gen).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 60_000);

  it("is still red with no compiler when every field is written and none is it", async () => {
    repo = scratchRepo({ ...RUST, "src/car.rs": "use crate::parts::{Engine, Wheel};\n\npub struct Car {\n    wheel: Box<dyn Wheel>,\n    engine: Engine,\n}\n" });
    expect(await redsOf(repo, ["src/car.rs#Car", "src/parts.rs#Seat", "holds"], { compiler: false })).toEqual(["holds-absent"]);
  }, 60_000);

  it.skipIf(!hasRustAnalyzer)("is withdrawn when rust-analyzer says `S` is a `Seat`", async () => {
    repo = scratchRepo({ ...RUST, "src/car.rs": car });
    const { each: [gen] } = await verdicts(repo, [["src/car.rs#Gen", "src/parts.rs#Seat", "holds"]]);
    expect(gen).toEqual({ reds: [], unconfirmed: "compiler-says-it-does" });
  }, 180_000);
});

const PY_ENGINE = "class Engine:\n    pass\n\n\nclass Motor:\n    pass\n";

describe("Python, a field with no written type", () => {
  it("stays quiet on `self.engine = Engine()` in `__init__`", async () => {
    repo = scratchRepo({ "engine.py": PY_ENGINE, "car.py": "from engine import Engine\n\n\nclass Car:\n    def __init__(self):\n        self.engine = Engine()\n" });
    const { each: [car] } = await verdicts(repo, [["car.py#Car", "engine.py#Engine", "holds"]]);
    expect(car).toEqual({ reds: [], unconfirmed: "compiler-says-it-does" });
  }, 120_000);

  it.each([
    ["`self.engine = engine` from a parameter typed `Engine`", "    def __init__(self, engine: Engine):\n        self.engine = engine\n"],
    ["an annotated field beside `self.engine = Engine()`", "    wheels: int\n\n    def __init__(self):\n        self.wheels = 4\n        self.engine = Engine()\n"],
    ["`self.engine = Engine()` set outside `__init__`", "    def start(self):\n        self.engine = Engine()\n"],
    ["`self.engine = None` first and `Engine()` later", "    def __init__(self):\n        self.engine = None\n\n    def start(self):\n        self.engine = Engine()\n"],
    ["a class-level `engine = Engine()`", "    engine = Engine()\n"],
    ["a property returning `Engine`", "    @property\n    def engine(self) -> Engine:\n        return Engine()\n"],
  ])("stays quiet on %s", async (_shape, body) => {
    repo = scratchRepo({ "engine.py": PY_ENGINE, "car.py": `from engine import Engine\n\n\nclass Car:\n${body}` });
    expect(await redsOf(repo, ["car.py#Car", "engine.py#Engine", "holds"])).toEqual([]);
  }, 120_000);

  it("still calls it wrong when pyright says the field is something else", async () => {
    repo = scratchRepo({ "engine.py": PY_ENGINE, "car.py": "from engine import Motor\n\n\nclass Car:\n    def __init__(self):\n        self.engine = Motor()\n" });
    expect(await redsOf(repo, ["car.py#Car", "engine.py#Engine", "holds"])).toEqual(["holds-absent"]);
  }, 120_000);

  it("is still red with no compiler when every field is annotated with something else", async () => {
    repo = scratchRepo({ "engine.py": PY_ENGINE, "car.py": "from engine import Motor\n\n\nclass Car:\n    engine: Motor\n\n    def __init__(self):\n        self.engine = Motor()\n" });
    expect(await redsOf(repo, ["car.py#Car", "engine.py#Engine", "holds"], { compiler: false })).toEqual(["holds-absent"]);
  }, 120_000);
});

/**
 * The ten correct field arrows #394 found red on the bench (#397), each in the
 * shape its repository writes it: httpx's `Request` and `Response`, flask's
 * `JSONTag` and `BlueprintSetupState`, poetry's `Installer` and `Executor`.
 * Kept quiet by the gate; turning them green is #397.
 */
const LIBRARY = {
  "pkg/__init__.py": "",
  "pkg/models.py": [
    "from __future__ import annotations",
    "",
    "",
    "class URL:",
    "    def __init__(self, url: str, params: dict | None = None) -> None:",
    "        self.raw = url",
    "",
    "",
    "class Headers:",
    "    def __init__(self, headers: dict | None = None) -> None:",
    "        self.raw = headers or {}",
    "",
    "",
    "class ByteStream:",
    "    def __init__(self, stream: bytes) -> None:",
    "        self._stream = stream",
    "",
    "",
    "class UnattachedStream:",
    "    pass",
    "",
    "",
    "class Request:",
    "    def __init__(self, url: str, params: dict | None = None, headers: dict | None = None, stream: ByteStream | None = None) -> None:",
    "        self.url = URL(url) if params is None else URL(url, params=params)",
    "        self.headers = Headers(headers)",
    "        if stream is not None:",
    "            self.stream = stream",
    "",
    "    def read(self) -> bytes:",
    "        self._content = b\"\"",
    "        self.stream = ByteStream(self._content)",
    "        return self._content",
    "",
    "    def __getstate__(self) -> dict:",
    "        return {}",
    "",
    "    def __setstate__(self, state: dict) -> None:",
    "        self.stream = UnattachedStream()",
    "",
    "",
    "class Response:",
    "    def __init__(self, status_code: int, headers: dict | None = None) -> None:",
    "        self.status_code = status_code",
    "        self.headers = Headers(headers)",
    "",
    "",
    "class Cookies:",
    "    def extract(self, response: Response) -> None:",
    "        self.last = self._CookieCompatResponse(response)",
    "",
    "    class _CookieCompatResponse:",
    "        def __init__(self, response: Response) -> None:",
    "            self.response = response",
    "",
  ].join("\n"),
  "pkg/tag.py": [
    "from __future__ import annotations",
    "",
    "",
    "class JSONTag:",
    "    key: str = \"\"",
    "",
    "    def __init__(self, serializer: TaggedJSONSerializer) -> None:",
    "        self.serializer = serializer",
    "",
    "",
    "class TaggedJSONSerializer:",
    "    default_tags = [JSONTag]",
    "",
  ].join("\n"),
  "pkg/app.py": "class App:\n    pass\n",
  "pkg/blueprints.py": [
    "from __future__ import annotations",
    "",
    "import typing as t",
    "",
    "if t.TYPE_CHECKING:  # pragma: no cover",
    "    from .app import App",
    "",
    "",
    "class BlueprintSetupState:",
    "    def __init__(self, blueprint: object, app: App, options: t.Any) -> None:",
    "        self.app = app",
    "        self.blueprint = blueprint",
    "        self.options = options",
    "",
  ].join("\n"),
  "pkg/executor.py": [
    "from __future__ import annotations",
    "",
    "from concurrent.futures import ThreadPoolExecutor",
    "",
    "",
    "class WheelInstaller:",
    "    def __init__(self, env: object) -> None:",
    "        self._env = env",
    "",
    "",
    "class Chef:",
    "    def __init__(self, env: object) -> None:",
    "        self._env = env",
    "",
    "",
    "class Chooser:",
    "    def __init__(self, env: object) -> None:",
    "        self._env = env",
    "",
    "",
    "class Executor:",
    "    def __init__(self, env: object, max_workers: int = 1) -> None:",
    "        self._env = env",
    "        self._wheel_installer = WheelInstaller(self._env)",
    "        self._chef = Chef(self._env)",
    "        self._chooser = Chooser(self._env)",
    "        self._executor = ThreadPoolExecutor(max_workers=max_workers)",
    "",
  ].join("\n"),
  "pkg/installer.py": [
    "from __future__ import annotations",
    "",
    "from pkg.executor import Executor",
    "",
    "",
    "class Installer:",
    "    def __init__(self, env: object, executor: Executor | None = None) -> None:",
    "        self._env = env",
    "        self._lock = False",
    "        if executor is None:",
    "            executor = Executor(self._env)",
    "",
    "        self._executor = executor",
    "",
  ].join("\n"),
};

describe("#394's ten correct Python field arrows (#397)", () => {
  const right: Array<[string, string]> = [
    ["pkg/models.py#Request", "pkg/models.py#URL"],
    ["pkg/models.py#Request", "pkg/models.py#Headers"],
    ["pkg/models.py#Request", "pkg/models.py#ByteStream"],
    ["pkg/models.py#Response", "pkg/models.py#Headers"],
    ["pkg/tag.py#JSONTag", "pkg/tag.py#TaggedJSONSerializer"],
    ["pkg/blueprints.py#BlueprintSetupState", "pkg/app.py#App"],
    ["pkg/installer.py#Installer", "pkg/executor.py#Executor"],
    ["pkg/executor.py#Executor", "pkg/executor.py#WheelInstaller"],
    ["pkg/executor.py#Executor", "pkg/executor.py#Chef"],
    ["pkg/executor.py#Executor", "pkg/executor.py#Chooser"],
  ];

  it("keeps every one of them from being called wrong", async () => {
    repo = scratchRepo(LIBRARY);
    const { each } = await verdicts(repo, right.map(([from, to]) => [from, to, "holds"]));
    expect(each.map((one, index) => [right[index]!.join(" -> "), one.reds])).toEqual(right.map((pair) => [pair.join(" -> "), []]));
  }, 180_000);
});

describe("a class nested in another (#394's gap in #395)", () => {
  it("is asked about through its outer class, so a wrong arrow from it stays red", async () => {
    repo = scratchRepo(LIBRARY);
    const { each: [compat] } = await verdicts(repo, [["pkg/models.py#_CookieCompatResponse", "pkg/models.py#Request", "holds"]]);
    expect(compat!.reds).toEqual(["holds-absent"]);
  }, 180_000);

  it("and a right one is not", async () => {
    repo = scratchRepo(LIBRARY);
    expect(await redsOf(repo, ["pkg/models.py#_CookieCompatResponse", "pkg/models.py#Response", "holds"])).toEqual([]);
  }, 180_000);
});
