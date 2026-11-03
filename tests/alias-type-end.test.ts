/**
 * "Alias takes takesShape", where `type Alias = Shape` (#479).
 *
 * The bad outcome, before this: an arrow that names a type by its alias was
 * called wrong whenever the code wrote the type under its own name. `takesShape`
 * takes a `Shape`, and `Alias` *is* `Shape`, so the arrow is right -- but the
 * reader looked for the word `Alias` in the signature, did not find it, and
 * went red. The same in `@returns` and `@holds`, in TypeScript, Python and Rust.
 * The opposite case (the code writes the alias, the arrow names the type) has
 * been "not sure" since #303.
 *
 * What counts: a type written in the signature or a field list that *is* what
 * the alias stands for, compared whole -- `Shape` for `type Alias = Shape`,
 * `Shape | Other` for `type Either = Shape | Other`, `Array<Shape>` for `type
 * Box<T> = Array<T>`. Never "shares a name with it": httpx's `HeaderTypes` is a
 * union naming `bytes` and `Tuple`, which `Headers`' one field also writes, and
 * `Headers @holds HeaderTypes` is a wrong arrow that stays red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, scratchRepo, verdicts, type ArrowVerdict } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const repos: string[] = [];
afterAll(() => { for (const repo of repos) dropRepo(repo); });

/** One arrow on a board of its own, checked with no compiler, as CI and a user without one do. */
async function verdict(files: Record<string, string>, from: string, to: string, claim: string): Promise<ArrowVerdict> {
  const repo = scratchRepo(files, "alias-type-end-");
  repos.push(repo);
  return (await verdicts(repo, [[from, to, claim]], { compiler: false })).each[0]!;
}

const RUST_CRATE = {
  "Cargo.toml": "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
  "src/lib.rs": "pub mod types;\npub mod usage;\n",
};

/**
 * Per language: a types file declaring the alias (`types`), and a file using
 * the type under its own name (`usage`). The alias and its reader are in two
 * files on purpose -- the alias is declared beside the type and imported from
 * there, which is the shape #303 found real code writes.
 */
interface Language {
  name: string;
  types: string;
  usage: string;
  /** Source text for each file, from a types body and a usage body. */
  files: (types: string, usage: string) => Record<string, string>;
}

const TS: Language = {
  name: "ts",
  types: "src/types.ts",
  usage: "src/use.ts",
  files: (types, usage) => ({
    "src/types.ts": `export interface Shape { n: number }\nexport interface Other { m: string }\n${types}`,
    "src/use.ts": `import { Shape, Other } from "./types";\n${usage}`,
  }),
};
const pythonWith = (name: string): Language => ({
  name,
  types: "pkg/types.py",
  usage: "pkg/use.py",
  files: (types, usage) => ({
    "pkg/__init__.py": "",
    "pkg/types.py": `from typing import Callable, Optional, TypeAlias, Union\n\nclass Shape:\n    n: int\n\nclass Other:\n    m: str\n\n${types}`,
    "pkg/use.py": `from typing import Callable, Optional, Union\nfrom pkg.types import Other, Shape\n\n${usage}`,
  }),
});
const RUST: Language = {
  name: "rust",
  types: "src/types.rs",
  usage: "src/usage.rs",
  files: (types, usage) => ({
    ...RUST_CRATE,
    "src/types.rs": `pub struct Shape { pub n: i32 }\npub struct Other { pub m: String }\npub struct Error;\n${types}`,
    "src/usage.rs": `use crate::types::{Error, Other, Shape};\n${usage}`,
  }),
};

/** Python's three spellings of an alias: the 3.12 statement, the annotation, and a plain assignment. */
const PYTHON_SPELLINGS = [
  { language: pythonWith("python `type`"), alias: (name: string, value: string, params = "") => `type ${name}${params ? `[${params}]` : ""} = ${value}\n` },
  { language: pythonWith("python TypeAlias"), alias: (name: string, value: string) => `${name}: TypeAlias = ${value}\n` },
  { language: pythonWith("python plain"), alias: (name: string, value: string) => `${name} = ${value}\n` },
];

/** The issue's own probe, in every language: an alias for a type, and the type written under its own name. */
const plain = [
  { language: TS, types: "export type Alias = Shape;\nexport type OtherAlias = Other;\n",
    usage: "export function takesShape(s: Shape): Shape { return s; }\nexport class Holder { s: Shape = { n: 1 }; }\n" },
  ...PYTHON_SPELLINGS.map(({ language, alias }) => ({
    language, types: alias("Alias", "Shape") + alias("OtherAlias", "Other"),
    usage: "def takesShape(s: Shape) -> Shape:\n    return s\n\nclass Holder:\n    s: Shape\n",
  })),
  { language: RUST, types: "pub type Alias = Shape;\npub type OtherAlias = Other;\n",
    usage: "pub fn takesShape(s: Shape) -> Shape { s }\npub struct Holder { pub s: Shape }\n" },
];

describe("an arrow naming a type by its alias, where the code writes the type", () => {
  for (const { language, types, usage } of plain) {
    const files = language.files(types, usage);
    const alias = `${language.types}#Alias`;
    const routine = `${language.usage}#takesShape`;
    const holder = `${language.usage}#Holder`;

    it(`is not called wrong by @takes, @returns or @holds in ${language.name}`, async () => {
      for (const [from, to, claim] of [[alias, routine, "takes"], [alias, routine, "returns"], [holder, alias, "holds"]] as const) {
        const answer = await verdict(files, from, to, claim);
        expect(answer.reds, `${from} @${claim} ${to}`).toEqual([]);
        expect(answer.unconfirmed, `${from} @${claim} ${to}`).toBe("aliased");
      }
    });

    it(`still calls an alias for a different type wrong in ${language.name}`, async () => {
      const other = `${language.types}#OtherAlias`;
      expect((await verdict(files, other, routine, "takes")).reds).toEqual(["signature-absent"]);
      expect((await verdict(files, other, routine, "returns")).reds).toEqual(["signature-absent"]);
      expect((await verdict(files, holder, other, "holds")).reds).toEqual(["holds-absent"]);
    });

    it(`still confirms the arrow drawn at the type itself in ${language.name}`, async () => {
      const shape = `${language.types}#Shape`;
      expect(await verdict(files, shape, routine, "takes")).toEqual({ reds: [] });
      expect(await verdict(files, holder, shape, "holds")).toEqual({ reds: [] });
    });
  }
});

/**
 * Aliases for more than a bare name. Each is asked of the type written out in
 * full where the code uses it -- and, for the guard, of a type that shares the
 * alias's names without being it.
 */
interface Shaped {
  what: string;
  language: Language;
  types: string;
  /** A routine `f` and a type `Holder` that write what the alias stands for. */
  same: string;
  /** The same two, writing something that shares names with it but is not it. */
  near: string;
}

const shaped: Shaped[] = [
  {
    what: "a type wrapped in another", language: TS, types: "export type Alias = Shape;\n",
    same: "export function f(s: Shape | undefined): void {}\nexport class Holder { s: Array<Shape> = []; }\n",
    near: "export function f(s: Other): void {}\nexport class Holder { s: Other[] = []; }\n",
  },
  {
    what: "a union, written in another order", language: TS, types: "export type Either = Shape | Other;\n",
    same: "export function f(s: Other | Shape): void {}\nexport class Holder { s: Other | Shape = { n: 1 }; }\n",
    near: "export function f(s: Shape): void {}\nexport class Holder { s: Shape | number = 1; }\n",
  },
  {
    what: "a generic, instantiated", language: TS, types: "export type Box<T> = Array<T>;\n",
    same: "export function f(s: Shape[]): void {}\nexport class Holder { s: Array<Other> = []; }\n",
    near: "export function f(s: Set<Shape>): void {}\nexport class Holder { s: Shape = { n: 1 }; }\n",
  },
  {
    what: "a function type", language: TS, types: "export type Handler = (n: number) => Shape;\n",
    same: "export function f(h: (n: number) => Shape): void {}\nexport class Holder { h: (n: number) => Shape = () => ({ n: 1 }); }\n",
    near: "export function f(h: (n: number) => Other): void {}\nexport class Holder { h: Shape = { n: 1 }; }\n",
  },
  {
    what: "a plain object type written out", language: TS, types: "export type Plain = { n: number };\n",
    same: "export function f(p: { n: number }): void {}\nexport class Holder { p: { n: number } = { n: 1 }; }\n",
    near: "export function f(p: { n: string }): void {}\nexport class Holder { p: number = 1; }\n",
  },
  ...PYTHON_SPELLINGS.flatMap(({ language, alias }): Shaped[] => [
    {
      what: "a type wrapped in another", language, types: alias("Alias", "Shape"),
      same: "def f(s: Optional[Shape]) -> None:\n    pass\n\nclass Holder:\n    s: list[Shape]\n",
      near: "def f(s: Optional[Other]) -> None:\n    pass\n\nclass Holder:\n    s: list[Other]\n",
    },
    {
      what: "a union, in another spelling", language, types: alias("Either", "Union[Shape, Other]"),
      same: "def f(s: Other | Shape) -> None:\n    pass\n\nclass Holder:\n    s: Union[Other, Shape]\n",
      near: "def f(s: Shape) -> None:\n    pass\n\nclass Holder:\n    s: Union[Shape, int]\n",
    },
    {
      what: "a callable", language, types: alias("Handler", "Callable[[int], Shape]"),
      same: "def f(h: Callable[[int], Shape]) -> None:\n    pass\n\nclass Holder:\n    h: Callable[[int], Shape]\n",
      near: "def f(h: Callable[[int], Other]) -> None:\n    pass\n\nclass Holder:\n    h: Callable[[Shape], int]\n",
    },
  ]),
  {
    what: "a generic, instantiated (3.12)", language: PYTHON_SPELLINGS[0]!.language,
    types: PYTHON_SPELLINGS[0]!.alias("Box", "list[T]", "T"),
    same: "def f(s: list[Shape]) -> None:\n    pass\n\nclass Holder:\n    s: list[Other]\n",
    near: "def f(s: set[Shape]) -> None:\n    pass\n\nclass Holder:\n    s: Shape\n",
  },
  {
    what: "a type wrapped in another", language: RUST, types: "pub type Alias = Shape;\n",
    same: "pub fn f(s: &mut Vec<Shape>) {}\npub struct Holder { pub s: Option<crate::types::Shape> }\n",
    near: "pub fn f(s: &mut Vec<Other>) {}\npub struct Holder { pub s: Option<Other> }\n",
  },
  {
    what: "a generic, instantiated", language: RUST, types: "pub type Res<T> = std::result::Result<T, Error>;\n",
    same: "pub fn f(r: Result<Shape, Error>) {}\npub struct Holder { pub r: std::result::Result<Other, Error> }\n",
    near: "pub fn f(r: Result<Shape, Other>) {}\npub struct Holder { pub r: Option<Error> }\n",
  },
  {
    what: "a function pointer", language: RUST, types: "pub type Callback = fn(i32) -> Shape;\n",
    same: "pub fn f(c: fn(i32) -> Shape) {}\npub struct Holder { pub c: fn(i32) -> Shape }\n",
    near: "pub fn f(c: fn(Shape) -> i32) {}\npub struct Holder { pub c: fn(i32) -> Other }\n",
  },
  {
    what: "a tuple", language: RUST, types: "pub type Pair = (Shape, Other);\n",
    same: "pub fn f(p: (Shape, Other)) {}\npub struct Holder { pub p: Vec<(Shape, Other)> }\n",
    near: "pub fn f(p: (Shape, Shape)) {}\npub struct Holder { pub s: Shape, pub o: Other }\n",
  },
];

const aliasOf = (types: string) => (/(?:^|\s)type\s+(\w+)/.exec(types) ?? /^(\w+)/.exec(types))![1]!;

describe("an alias for more than a bare name: compared whole", () => {
  for (const { what, language, types, same, near } of shaped) {
    const name = aliasOf(types);
    const alias = `${language.types}#${name}`;
    const f = `${language.usage}#f`;
    const holder = `${language.usage}#Holder`;

    it(`is not called wrong when the code writes it out (${what}, ${language.name})`, async () => {
      const files = language.files(types, same);
      const takes = await verdict(files, alias, f, "takes");
      expect(takes.reds).toEqual([]);
      expect(takes.unconfirmed).toBe("aliased");
      const holds = await verdict(files, holder, alias, "holds");
      expect(holds.reds).toEqual([]);
      expect(holds.unconfirmed).toBe("aliased");
    });

    it(`is still called wrong when the code only shares names with it (${what}, ${language.name})`, async () => {
      const files = language.files(types, near);
      expect((await verdict(files, alias, f, "takes")).reds).toEqual(["signature-absent"]);
      expect((await verdict(files, holder, alias, "holds")).reds).toEqual(["holds-absent"]);
    });
  }
});

describe("the issue's guard: httpx's Headers does not hold HeaderTypes", () => {
  /*
   * Cut down from httpx's `_types.py` and `_models.py` at the corpus pin. Red on
   * main and a wrong arrow: `Headers` keeps a list of byte triples, and
   * `HeaderTypes` is what its constructor *takes*. The union names `Tuple` and
   * `bytes`, which the field writes too -- a rule that withheld on any shared
   * name would lose this red, and comparing the whole written type keeps it.
   */
  const files = {
    "httpx/__init__.py": "",
    "httpx/_types.py": [
      "from typing import TYPE_CHECKING, Mapping, Sequence, Tuple, Union",
      "",
      "if TYPE_CHECKING:  # pragma: no cover",
      "    from ._models import Headers  # noqa: F401",
      "",
      "HeaderTypes = Union[",
      "    \"Headers\",",
      "    Mapping[str, str],",
      "    Mapping[bytes, bytes],",
      "    Sequence[Tuple[str, str]],",
      "    Sequence[Tuple[bytes, bytes]],",
      "]",
      "",
    ].join("\n"),
    "httpx/_models.py": [
      "import typing",
      "from ._types import HeaderTypes",
      "",
      "class Headers(typing.MutableMapping[str, str]):",
      "    def __init__(self, headers: HeaderTypes | None = None, encoding: str | None = None) -> None:",
      "        self._list: typing.List[typing.Tuple[bytes, bytes, bytes]] = []",
      "        self._encoding = encoding",
      "",
    ].join("\n"),
  };

  it("stays red", async () => {
    const answer = await verdict(files, "httpx/_models.py#Headers", "httpx/_types.py#HeaderTypes", "holds");
    expect(answer.reds).toEqual(["holds-absent"]);
  });
});
