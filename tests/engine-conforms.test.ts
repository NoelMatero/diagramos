/**
 * Whether a type's declaration says it is one of another type (#216).
 *
 * The reader, not the report -- `conforms-claims.test.ts` covers what anybody is
 * told. What is covered here is the thing an accusation rests on: a base list is
 * written in the declaration, so a base that is not in it is not a base, and
 * saying so is only safe where the reader can see the whole list.
 *
 * Three languages spell it four ways and one of them is not a declaration at
 * all, which is the whole shape of this file:
 *
 *   `class Handler(Base):`          python, closed
 *   `class A extends B`             typescript, closed
 *   `class A implements C`          typescript, closed
 *   `interface X extends Y`         typescript, closed -- and 470 of the 2,919
 *   `impl Trait for Type`           rust, and the region is the crate
 */
import { beforeAll, describe, expect, it } from "vitest";

import { conformedTypes, declaredBases } from "../src/engine/conforms";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 60_000);

describe("a Python class naming one base", () => {
  it("confirms the base it names, with the line to go and read", () => {
    const source = "class Base:\n    pass\n\n\nclass Handler(Base):\n    pass\n";
    const verdict = conformedTypes(source, "Handler", ["Base"], "python");

    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.name).toBe("Base");
    expect(verdict.evidence.line).toBe(5);
  });
});

describe("a Python class naming several bases", () => {
  it("confirms any one of them, not just the first", () => {
    const source = "class Handler(Base, Mixin, metaclass=ABCMeta):\n    pass\n";

    expect(conformedTypes(source, "Handler", ["Base"], "python").verdict).toBe("confirmed");
    expect(conformedTypes(source, "Mixin", ["Base"], "python").verdict).not.toBe("confirmed");
    expect(conformedTypes(source, "Handler", ["Mixin"], "python").verdict).toBe("confirmed");
  });

  it("does not read a keyword argument as a base", () => {
    /*
     * `metaclass=ABCMeta` is not something the class is one of. Reading the
     * value out of it would confirm an arrow drawn at ABCMeta, which is a green
     * on a claim nobody could refute -- the decoration `claim.ts` refuses to
     * admit a word for.
     */
    const source = "class Handler(Base, metaclass=ABCMeta):\n    pass\n";
    expect(conformedTypes(source, "Handler", ["ABCMeta"], "python").verdict).not.toBe("confirmed");
  });
});

describe("the three ways TypeScript writes it", () => {
  it("confirms a class extending a class", () => {
    const source = "class Cache {}\nexport class Store extends Cache {}\n";
    expect(conformedTypes(source, "Store", ["Cache"], "ts").verdict).toBe("confirmed");
  });

  it("confirms a class implementing an interface, in the same clause as its base", () => {
    const source = "export class Store extends Cache implements Reader {}\n";
    expect(conformedTypes(source, "Store", ["Cache"], "ts").verdict).toBe("confirmed");
    expect(conformedTypes(source, "Store", ["Reader"], "ts").verdict).toBe("confirmed");
  });

  it("confirms an interface extending an interface", () => {
    /*
     * 470 of the 2,919 and the whole of tsx -- there is not one class heritage
     * clause in any .tsx file in the corpus. A reader written for
     * `class_declaration` alone would refuse the largest TypeScript case.
     */
    const source = "interface Base { id: string }\nexport interface Props extends Base { n: number }\n";
    expect(conformedTypes(source, "Props", ["Base"], "ts").verdict).toBe("confirmed");
  });

  it("reads a generic base through its type arguments", () => {
    const source = "export class Store extends Cache<Entry> {}\n";
    expect(conformedTypes(source, "Store", ["Cache"], "ts").verdict).toBe("confirmed");
  });
});

describe("Rust, where the fact is not on the declaration", () => {
  it("confirms an impl that sits in the same file as the type", () => {
    const source = "pub struct Orangutan;\n\nimpl Router for Orangutan {\n    fn route(&self) {}\n}\n";
    const verdict = conformedTypes(source, "Orangutan", ["Router"], "rust");

    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.line).toBe(3);
  });

  it("says the region is the crate when the impl is in another file, and never accuses", () => {
    /*
     * The whole reason Rust is confirm-only. `impl Trait for Type` is a
     * free-standing item that may sit next to neither the trait nor the type, so
     * this file enumerating nothing is not evidence of anything -- and a red here
     * would be a false accusation in the language this project has the least of.
     */
    const source = "pub struct Orangutan;\n\nimpl Orangutan {\n    fn new() -> Self { Self }\n}\n";
    const verdict = conformedTypes(source, "Orangutan", ["Router"], "rust");

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("region-is-the-crate");
  });

  it("does not confirm an impl of the same trait for a different type", () => {
    const source = "pub struct Orangutan;\npub struct Monkey;\n\nimpl Router for Monkey {}\n";
    expect(conformedTypes(source, "Orangutan", ["Router"], "rust").verdict).not.toBe("confirmed");
  });

  it("confirms a supertrait, which Rust does write on the declaration", () => {
    const source = "pub trait Reader {}\npub trait Cache: Reader {}\n";
    expect(conformedTypes(source, "Cache", ["Reader"], "rust").verdict).toBe("confirmed");
  });
});

describe("the reasons to say nothing", () => {
  it("withholds when a base is imported under another name", () => {
    const source = "import { Base as B } from './base';\nexport class Store extends B {}\n";
    const verdict = conformedTypes(source, "Store", ["Base"], "ts");

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("aliased");
  });

  it("withholds when the base is an expression rather than a name", () => {
    // The mixin pattern. What `mixin(B)` returns is not readable off the text,
    // so an absence here would be about a name the reader never saw.
    const source = "export class Store extends mixin(Cache) {}\n";
    const verdict = conformedTypes(source, "Store", ["Reader"], "ts");

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("computed-base");
  });

  it("withholds on a Python class whose base comes out of a factory", () => {
    const source = "class Handler(make_base()):\n    pass\n";
    const verdict = conformedTypes(source, "Handler", ["Base"], "python");

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("computed-base");
  });

  it("withholds when the tail is a routine, because a routine has no bases", () => {
    /*
     * The category error this word will meet most: a function that satisfies a
     * protocol is the structural claim that is not on offer, and it is the
     * nearest word to reach for.
     */
    const source = "def handler(request):\n    return None\n";
    const verdict = conformedTypes(source, "handler", ["Protocol"], "python");

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("subject-not-a-type");
  });

  it("withholds when the far end is a routine", () => {
    const source = "class Handler(Base):\n    pass\n";
    const far = { source: "def handler(request):\n    return None\n", language: "python" as const };
    const verdict = conformedTypes(source, "Handler", ["handler"], "python", far);

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("not-a-type");
  });

  it("withholds when the tail is an alias for a type declared elsewhere", () => {
    const source = "type Store = Cache;\n";
    const verdict = conformedTypes(source, "Store", ["Reader"], "ts");

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("aliased");
  });

  it("withholds when nothing in the file declares the name", () => {
    const verdict = conformedTypes("export const x = 1;\n", "Store", ["Cache"], "ts");
    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("not-declared");
  });
});

describe("a base with type arguments on it", () => {
  /*
   * Found by `measure:conforms`, in mundane:
   *
   *     export class ListboxStore extends ReactStore<
   *       ListboxState,
   *       ListboxContext,
   *       typeof selectors
   *     > {
   *
   * TypeScript hangs a class's type arguments off the clause as a `type_arguments`
   * sibling of the base name rather than wrapping the two together, and the first
   * version of this reader had no rule for that node -- so it fell through to
   * "not a name I can read" and refused the whole declaration as a computed base.
   * One refusal in 214, and the refusal was the reader's own blind spot rather
   * than anything about the code.
   *
   * The other half is a decision rather than a bug. `type-argument` is 12.6% of
   * all code and is deliberately outside this vocabulary (#187): `Store` is not
   * one of `ListboxState`, it is one of `ReactStore`. So the arguments are not
   * read as bases at all -- which is the opposite of what `holds.ts` does with
   * `Vec<RouteInfo>`, where the inner type really is held.
   */
  it("reads the base and not its type arguments, and finds nothing to doubt", () => {
    /*
     * Asked of the base list rather than of the verdict, because both halves
     * have to hold and the verdict only shows one of them. `Cache` confirms
     * either way; what the first reader got wrong was carrying a permanent
     * `doubt` on the declaration, which silences every *absence* on it -- so an
     * arrow drawn at something `Store` is not one of could never be called
     * wrong. A word that ships and never fires, and invisible from the
     * confirming side.
     */
    const read = declaredBases("export class Store extends Cache<Entry> {}\n", "Store", "ts");

    expect("why" in read).toBe(false);
    if ("why" in read) return;
    expect(read.bases.map((base) => base.name)).toEqual(["Cache"]);
    expect(read.doubt).toBeUndefined();
    expect(read.closed).toBe(true);
  });

  it("does not doubt a base whose type arguments run over several lines", () => {
    const source = "export class Store extends Cache<\n  State,\n  Context,\n  typeof selectors\n> {}\n";
    const read = declaredBases(source, "Store", "ts");

    expect("why" in read).toBe(false);
    if ("why" in read) return;
    expect(read.bases.map((base) => base.name)).toEqual(["Cache"]);
    expect(read.doubt).toBeUndefined();
  });

  it("reads a Python generic base as the generic, not its parameter", () => {
    const source = "class Handler(Generic[T]):\n    pass\n";

    expect(conformedTypes(source, "Handler", ["Generic"], "python").verdict).toBe("confirmed");
    expect(conformedTypes(source, "Handler", ["T"], "python").verdict).not.toBe("confirmed");
  });

  it("still reads a qualified base by the name a box would carry", () => {
    const source = "class Handler(abc.ABC):\n    pass\n";
    expect(conformedTypes(source, "Handler", ["ABC"], "python").verdict).toBe("confirmed");
  });
});

describe("a Rust type that derives its conformance", () => {
  /*
   * Found by widening the Rust corpus to the five pinned clones the dependency
   * licence already uses (#216, after the word had shipped). `impl Trait for
   * Type` is not how most Rust conformance is written:
   *
   *     1,401 written trait impls
   *     3,741 conformances from #[derive(..)]
   *
   * Two and a half times as many, and the first reader could see none of them.
   * `#[derive(Clone, Debug)]` generates the impls at compile time, so there is
   * no `impl Clone for Config` anywhere in the source to find -- and a board
   * saying `Config --@conforms--> Serialize` about a derived Serialize was
   * getting silence when the answer was written on the declaration.
   *
   * Confirmation only, like every other Rust answer here. A derive list is
   * written on the type and a manual `impl` can be anywhere in the crate, so
   * neither is closed and their union is not either.
   */
  it("confirms a trait the type derives", () => {
    const source = "#[derive(Clone, Debug)]\npub struct Config {\n    pub width: u32,\n}\n";

    expect(conformedTypes(source, "Config", ["Clone"], "rust").verdict).toBe("confirmed");
    expect(conformedTypes(source, "Config", ["Debug"], "rust").verdict).toBe("confirmed");
  });

  it("confirms a derive written as a path, by the name a box would carry", () => {
    const source = "#[derive(serde::Serialize)]\npub struct Config;\n";
    expect(conformedTypes(source, "Config", ["Serialize"], "rust").verdict).toBe("confirmed");
  });

  it("confirms a derive on an enum, and reads past an attribute that is not one", () => {
    const source = '#[derive(Debug)]\n#[serde(rename_all = "kebab-case")]\npub enum Mode {\n    Fast,\n}\n';

    expect(conformedTypes(source, "Mode", ["Debug"], "rust").verdict).toBe("confirmed");
    // `serde(..)` is configuration, not a conformance. Confirming `rename_all`
    // would be a green on a claim nothing could ever refute.
    expect(conformedTypes(source, "Mode", ["rename_all"], "rust").verdict).not.toBe("confirmed");
    expect(conformedTypes(source, "Mode", ["serde"], "rust").verdict).not.toBe("confirmed");
  });

  it("does not lend one type's derives to the type declared after it", () => {
    const source = "#[derive(Clone)]\npub struct Config;\n\npub struct Other;\n";

    expect(conformedTypes(source, "Config", ["Clone"], "rust").verdict).toBe("confirmed");
    expect(conformedTypes(source, "Other", ["Clone"], "rust").verdict).not.toBe("confirmed");
  });

  it("still never accuses, even with a derive list right there", () => {
    // A derive list is not a closed region: a manual `impl` may be in any file
    // in the crate, so a trait missing from the derives proves nothing.
    const source = "#[derive(Clone)]\npub struct Config;\n";
    const verdict = conformedTypes(source, "Config", ["Router"], "rust");

    expect(verdict.verdict).toBe("withheld");
    if (verdict.verdict !== "withheld") return;
    expect(verdict.why).toBe("region-is-the-crate");
  });
});
