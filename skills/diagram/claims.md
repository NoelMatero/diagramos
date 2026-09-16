# Claims, one at a time

Read the part for the claim you are about to write. Every claim is optional,
and every one is written only from code you read. The reasons behind these
rules are in `docs/drawing-guide-long.md` in the diagramos repository.

A claim can come back three ways: **confirmed**, **unconfirmed** (nothing
proved it either way; not a finding), or **red** (the code contradicts it, with
a file and a line). Where the checker cannot see enough, it says nothing rather
than guessing.

## `claim: "needs"`

`from` imports, requires or includes `to`. Ends may be files or symbols.
Red when the dependency runs only the other way: turn the arrow round. It shows
on the arrow's label as `@needs`, and a person can type that label too.

## `claim: "feeds"`

`from`'s result goes into `to`: a pipeline. Often the opposite way from the
import. Both ends are symbols. Never red: it confirms when it finds one function
passing the first result to the second, and stays quiet otherwise.

## `claim: "takes"` and `claim: "returns"`

The arrow runs from a **type** to a **function**. `takes`: the function has a
parameter of that type. `returns`: its return type is that type.

```
{ from: "request", to: "handler", claim: "takes" }
{ from: "error", to: "error_new", claim: "returns" }
```

Red when the type is absent from the signature. Claim the wrong one of the two
and you are told the type is on the other side instead. Silent when the type
could be hiding behind an alias or a renamed import.

## `claim: "holds"`

The arrow runs from the **container** type to the type of one of its fields:
`route_info → response` means RouteInfo has a Response field. Wrappers count:
`Vec<T>`, `Promise<T>`, `Optional[T]`, `T[]`. Red when no field has that type.

## `claim: "builds"`

`from` makes a value of type `to`: `new X`, `X { .. }`, `<X />`. `from` may be a
routine, or a type whose routines do the making. Red only when the construction
is found at the far end and only there, meaning the arrow is backwards. Never
red for not finding it. No verdict in Python. `<div />` does not count.

## `claim: "calls"`

`from` calls `to`. Both ends are symbols. Red only when the call is found at the
far end and only there. Silent for method calls on untyped values, wildcard
imports, package names and calls inside Rust macros. If what moves is a value,
use `feeds`.

## `claim: "accesses"`

`from` (a routine) reads a member of `to` (a type). Put the member name in the
arrow's `label`:

```
{ from: "renderer", to: "config", label: "width", claim: "accesses" }
```

It shows as `width @accesses`. With prose or nothing in the label, it is a claim
nothing can read. Red when the type does not declare that member. Never red
about the routine. Silent when the type's members are open: it extends another
type, has an index signature, defines `__getattr__`, or has its Rust `impl` in
another file.

## `claim: "conforms"`

`from` extends or implements `to`. Subtype first: `handler → base`. Red in
Python and TypeScript when the base is not in the declaration, including an
arrow drawn base-first. Never red in Rust, where `impl Trait for Type` can be in
any file. Type arguments are not bases: `Store extends Cache<Entry>` says
nothing about Entry. An arrow at a function is a claim nothing can read.

## `handles: [...]` on a box

The box's ref names one routine that dispatches on a fixed set of cases: a
`match`, a `switch`, a router on methods. List every case:

```
{ id: "status", ref: "src/route.ts#status", handles: ["GET", "POST", "DELETE"] }
```

Red when the code has a case the list lacks, or the list has a case the code
lacks. A partial list is a false claim. Not judged: a `_` or `default` arm (for
the missing-case half), two dispatches in one routine, cases it cannot name,
`if`/`elif` ladders, and languages other than TypeScript (it confirms there).

## `closed: {...}` on a box

The box's ref is a directory, and nothing outside it imports anything inside
it except through the files in `through`:

```
{ id: "engine", label: "the engine", ref: "src/engine",
  closed: { through: ["src/engine/index.ts"] } }
```

Empty `through` claims total isolation. Red on the first outside import, by
file and line. Test files are counted apart and do not make it red. Look at
`check_drift`'s `closedBreaches` before claiming it.

## `complete: "<dir>"` on the board

Passed to `create_diagram` beside `title`. Every module under that directory
that the board reaches (imports, or is imported by, a box) must have a box.
Refused on a scope that is not a directory, on a scope one box already covers,
and on a concept board. Leave it off unless the user wants the board held to
this.

## On `planned` things

A claim on a `planned` box or arrow is a specification. Nothing checks it until
the code lands and the thing turns `built`.
