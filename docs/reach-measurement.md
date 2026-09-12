# How many steps the arrow check can follow

`npm run measure:reach`

An arrow between two routines is right when the head really reaches the tail
and wrong when it provably cannot. This is the measurement of both halves,
before and after #reach, and of what each one costs.

It exists because the two halves had a wall rather than a budget.
`body.ts`'s `reaches` follows calls as deep as they go **inside one file** --
`bodiesFor` looks a callee's name up in the tree it already parsed, so a chain
ends at the first file boundary, and most real chains cross one. And the only
word entitled to say "wrong" about a call (`@calls`) is about the *direct*
call, so an arrow drawn one level above a helper got a red.

## The answer key, and why it is not us

`scripts/lib/reach-graph.ts`. Per language, a call graph built by something
that shares no machinery with the reader:

| language | routines and call sites from | where each call lands |
|---|---|---|
| typescript | `ts.Program`, the compiler's own function-like declarations | `checker.getResolvedSignature` |
| python | `call-scan.ts`'s text referee — a `def` by the shape of its opening line, resolving nothing | pyright, "go to definition" |
| rust | the same text referee, `fn` by its opening line | rust-analyzer, the same question |

TypeScript uses the compiler end to end because `call-scan.ts` cannot see a
class method, and a corpus of TypeScript with the methods left out is not a
corpus of TypeScript.

Expanded lazily: a reach question only touches the routines forward of its own
start, so a node's successors are resolved the first time somebody asks and
remembered after. A complete graph over `django-django` is hundreds of
thousands of language-server round trips and nobody needs one.

## The two populations, and what a negative one has to earn

**reaches** is a chain of resolved calls the referee found. A path found is a
path, so this needs no completeness argument.

**never** is harder and has to be earned twice. The referee's forward closure
from the head must be *complete* — every call site of every routine on it
resolved — and the tail must not be in it. Then a second guard: the tail's
name must appear nowhere in any file the closure touches, which is what stands
in for the callback the referee cannot see. A routine whose name is never
written in the closure cannot be handed out of it as a value either.

Even then it is static-call reach and no more.

**The population is not vacuous, and that is on the record rather than
assumed.** A zero in the "goes green wrongly" column has two causes that look
identical -- the reader is careful, or nothing could have caught it out. On
its first run this population caught the body search confirming 60 Rust
arrows and 8 Python ones on a name that meant something else
(docs/claim-vocabulary.md item 26).
A cheap live version runs beside it every time: the same head asked about a
name nothing declares, which must never come back reached.

## What changed

Numbers from the pinned `.corpus` clones in `licence.ts`, two repositories per
language. `today` is the engine before #reach; `reach` is after.

```
npm run measure:reach          # 6 trees, seeds=400, ~40 minutes (the language servers are the 40)
```

**Arrows the compiler says really do reach, that the checker confirms.**

| | asks | before | after | multi-step before | multi-step after |
|---|---:|---:|---:|---:|---:|
| typescript | 545 | 232 (42.6%) | **452 (82.9%)** | 98 / 406 | **321 / 406** |
| python | 457 | 350 (76.6%) | **346 (75.7%)** | 38 / 145 | **84 / 145** |
| rust | 983 | 423 (43.0%) | 305 (31.0%) | 135 / 695 | 98 / 695 |

"multi-step" is every pair two or more calls apart, which is the population
this was built for. Per depth, written `before → after` out of the asks at
that depth:

| steps | typescript | python | rust |
|---|---|---|---|
| 1 | 134 → 131 (of 139) | 312 → 262 (of 312) | 288 → 207 (of 288) |
| 2 | 45 → **99** (of 115) | 29 → **56** (of 78) | 75 → 60 (of 156) |
| 3 | 33 → **81** (of 95) | 7 → **19** (of 37) | 26 → 25 (of 105) |
| 4 | 13 → **60** (of 69) | 2 → **8** (of 21) | 10 → 8 (of 96) |
| 5 | 5 → **43** (of 55) | 0 → **1** (of 8) | 4 → 1 (of 116) |
| 6 | 2 → **38** (of 72) | 0 → 0 (of 1) | 20 → 4 (of 222) |

**Arrows that go green and should not.** This is the number Rust's row above
is the price of.

| | before | after |
|---|---:|---:|
| typescript | 0 of 384 | 0 of 384 |
| python | 8 of 792 | **1 of 792** |
| rust | 60 of 1,572 | **9 of 1,572** |

As precision: Rust 87.6% → **97.1%**, Python 97.8% → **99.7%**, TypeScript
100% either way.

**Arrows called wrong.** The engine has never had a "never reaches" verdict
and still does not give one; `reach.ts` computes it and nothing reads it. What
the measurement says about it, and why, is in that file's header.

| | right | wrong | of |
|---|---:|---:|---:|
| typescript | 24 | 0 | 384 |
| python | 12 | 0 | 792 |
| rust | 11 | 0 | 1,572 |

Separately, and this is the one that was costing something: what `@calls` said
about the pairs a compiler says genuinely reach. 58 `refuted` and one
`backwards` on TypeScript, 3 `refuted` on Python — **62 red accusations on
arrows whose code really does get there**. They are advisories now
(`calls-one-level-up`), and the 96 + 84 `refuted` on pairs that genuinely do
not reach are untouched.

## What it costs

**Rust confirms 118 fewer arrows than it used to. 51 of those were wrong, and
67 were correct arrows that lost their green** -- and on a project whose
`Cargo.toml` rust-analyzer will load, the compiler channel below gets those
back. That is one trade, not two numbers: the rule that stops
`chain.rs#len` being read as reaching `context.rs#source` because its body
writes `cause.source()` also stops every *correct* method call being read that
way, and at tier 1 -- no compiler at check time -- the two are the same shape
in the text. Python pays 50 one-step confirmations for the same rule and gets
most of them back through the walk.

Those arrows do not go red. They go from green to "nothing corroborated
this", which is amber and true. The argument for preferring it is
CLAUDE.md's own worked example: 17 of 39 arrows unverifiable and `0 findings ·
exit 0` is a diagram that *looked* checked.

**One rule, reversible.** `ownTokensOf` in `src/engine/body.ts`, and the one
line in `checkSymbolEdge` that asks for it when the two ends are in different
files. Anybody who would rather have Rust's 118 greens back, and its 51 wrong
ones with them, changes that argument to `false`.

**Time: under a millisecond an arrow, with no compiler.** `measure:reach`
prints it per language: 0.7 ms on TypeScript over 929 asks, 0.3 ms on Rust
over 2,555, 0.1 ms on Python over 1,249.

The walk is asked in two places and nowhere else: where the one-file search
failed to confirm a symbol-anchored arrow, and where `@calls` is about to
accuse. Never on an arrow that already passed. Bodies are read at most once
per file per check (`ReachCache`).

`npm run check:drift` on this repository's fourteen boards: 1.64s before,
1.52s after, byte-identical output. None of those boards has an arrow that
needed the walk, which is the other half of the cost answer: it costs nothing
where it is not needed. The compiler channel's own costs are in the table
above.

## The compiler channel, and why it is not in the numbers above

Every figure on this page is the reader **without a compiler**. That is not
how the product runs and it is not an accident.

`check:drift` has built a real `ts.Program` since #233 and spawned real
pyright since #243. #reach adds three things to that:

- **rust-analyzer is wired into the live check at all.** It existed only in
  the measurement scripts, so a Rust board got no receiver resolved at check
  time.
- **"Go to definition" is asked.** The engine's hook for it (`declarationAt`)
  was built for `@accesses` at #255 and answered for TypeScript only. It is
  now answered for all three, and the walk asks it about every call the reader
  could not place. It is the better question: `Orangutan::new(addr)` is a
  *type* at the receiver position, so "what type is the receiver" has nothing
  to say about it, while "where is `new` declared" lands on the `impl`.
- **The recording pass repeats.** One pass was enough while the only caller
  read one file's bodies. A cross-file walk reaches a second file only by
  placing a call in the first, so a single pass harvests the first hop of
  every chain and never learns there was a second. It now runs up to three
  rounds, stopping when a round asks nothing new.

**Why none of it is in the table.** The answer key for TypeScript is `tsc`. A
reader that asks `tsc` and is marked by `tsc` cannot be caught being wrong --
it would score 100% and the 60 false passes on Rust would have been invisible.
Same for rust-analyzer. So the measured number is the floor, and the product
does better than it on any project whose compiler will load.

**What that is worth, on real boards.** `rust-test/boot-and-routing.excalidraw`
has 17 arrows over a small Rust crate. Two of them are path calls --
`fn main → Orangutan::new`, `Orangutan::run → Route::new` -- and they are
exactly what the safety rule above costs: without a compiler they go from
green to "not verified". With rust-analyzer answering, both come back, and the
board reports the same four unverified arrows it did before any of this work.
Not by a name coincidence this time.

A three-file Rust crate drawn `main → encode`, two calls apart through
`Server::run`: not confirmed before, confirmed now. A Flask board drawn
`make_response → dumps` and `get_command → _get_current_object`: one confirmed
before, both now.

**What it costs, on those same boards.**

| | before | after |
|---|---:|---:|
| this repository, 14 TypeScript boards | 1.64s | 1.52s |
| a 3-file Rust crate, 1 arrow | 1.2s | 0.9s |
| `rust-test`, 17 arrows over a Rust crate | 1.3s | 4.5s |
| a Flask board, 4 boxes and 2 arrows | 1.6s | 7.2s |

TypeScript pays nothing: `tsc` was already being built for every run.
Python and Rust pay a few seconds *on a board that has something unsettled*,
and nothing at all on one whose arrows all confirm -- a tier-1 pass, which
starts no server, decides which.

Two caveats worth knowing, because both are invisible otherwise.
**rust-analyzer answers nothing about a file no `Cargo.toml` claims** -- that
fixture had no manifest over `src/` until one was added for this check, and
every query in it came back unclaimed and silent. And the Rust figure was
**61 seconds** until the language-server clients' timers were `unref`ed: a
request that answered left its 30-second timeout pending, and `whenPrimed`
left a 60-second one, so Node declined to exit long after the work was done.
Three seconds of server, 66 milliseconds of walking, and 57 seconds of
waiting for a timer nobody needed. Only visible because this is the first
caller that warms a server and then lets the process end on its own; every
earlier one was a measurement script finishing in an explicit `process.exit`.

## What is still out of reach

**A receiver nothing typed, with no compiler running.** Of the refusals on
pairs that do reach: 476 of Rust's 695, 69 of Python's 111, 50 of
TypeScript's 93. Of the refusals on pairs that do not: 988 of Rust's 1,552,
467 of Python's 779, 204 of TypeScript's 360.

That clause carries the whole of it, and getting it wrong is easy enough that
it is worth spelling out. `self.inner.by_ref()` in `anyhow` is the shape:
`inner`'s type is declared on a struct in *another file*, and `resolution.ts`
reads one file, so the text reader cannot place it and the benchmark counts
it here. **A compiler places it immediately, and one is asked**: rust-analyzer
answers `src/ptr.rs:48` for that exact call, pyright answers
`httpx/_urls.py:327` for `self.base_url.copy_with(..)`, and an `anyhow` board
drawn `error.rs#chain -> ptr.rs#deref` is unconfirmed before this work and
confirmed after it. A definition is asked at the *method's* own position, so
it never needs the field's type as a separate question -- which is why this
population is the reason the measured number is a floor, and not a list of
things the product cannot do.

A cross-file field-type lookup in `resolution.ts` was going to raise the
floor, and the number says not to build it. `resolveReceiversIn`'s own
refusals, counted over the corpus:

| | receiver sites | resolved | `no-fields` |
|---|---:|---:|---:|
| ripgrep | 8,623 | 1,800 | **45** |
| anyhow | 273 | 70 | **11** |
| encode-httpx | 2,707 | 130 | **109** |
| pallets-flask | 2,835 | 182 | **41** |

`no-fields` is the whole of what a field-type reader could address: 45 of
ripgrep's 6,823 withheld sites. What actually withholds is `not-a-name` --
4,040 in ripgrep, an expression receiver like `make().run()` or `a.b.c()`,
which no reader of text can ever type -- and `imported-type`, 2,028 across the
two Python trees, which is mostly a module receiver that `calls.ts` places by
itself anyway.

## What would make `never reaches` licensable, and what would not

`never` needs a **closed** region, and closure is conjunctive: it holds when
every site places, so settling the commonest single doubt buys nothing on a
closure that also has a different one. A histogram of first doubts cannot say
that, so `measure:reach` counts refusals by the **whole set** of doubts on the
closure. A row naming one kind is a refusal one new reader would turn into an
answer.

| | refusals | one kind only | the rest |
|---|---:|---:|---|
| vuejs-core | 276 | **72**, all `receiver` | 84 `receiver+unbound`, then longer sets |
| TanStack-query | 24 | **12**, all `receiver` | 12 `receiver+unbound+unplaced` |
| anyhow | 965 | **83**, all `receiver` | 420 `macro+receiver+unbound`, 96 `macro+unbound` |
| pallets-flask | 24 | **0** | 12 `receiver+unbound`, 12 `+unplaced` |

Three things follow, and the third is the one that matters.

**Rust's ceiling is structural, not a missing reader.** 420 of anyhow's 965
refusals are blocked by a `macro` among others. A macro's arguments are tokens
waiting for an expansion that has not happened, so no grammar parses them and
no closure can be drawn around them. Half of ripgrep's receivers are
expression receivers besides. No amount of type reading reaches either.

**Python's refusals are never one thing.** 0 of 24 on the sample above -- a
thin sample, and the shape is unambiguous: every one needs a receiver reader
*and* an unbound reader.

**TypeScript's 84 receiver-only refusals are already settled in the
product.** `tsc` places those receivers with a concreteness answer, which is
exactly what a closure needs, and `check:drift` has had it wired since #233.
The gap is in what this benchmark can *see*, not in what the checker can do --
and it cannot see it, because its answer key is `tsc`.

So the only honest route to a licensable `never` is an independent referee for
a **compiler-backed** reader, and the repository has the parts for exactly one:
pyright as the reader, `resolution-python-mypy.ts` as the referee, Python only.
Two unrelated type checkers disagreeing is a real number. Everything else on
this page either measures the text reader against a compiler, which is the
floor, or would measure a compiler against itself.

**That number already exists and it is good.** Item 22 of
`docs/claim-vocabulary.md`: pyright's answers put to mypy over 12,409 sites,
and after #259 taught the client to withhold on a line that declares no type,
mypy's 460 wrong files went to **0**, with 0.35% disagreeing on the
consistency axis. So the type answers a Python closure would rest on are
sound, independently checked, by a different implementation of the language.

Which leaves one thing between `never` and a licence, and it is not a type
question at all: **a call nobody can see.** A callback handed out, a
`getattr`, a decorator, a dispatch table. `calls.ts` has said so since #189 --
"a routine that never writes `b()` can still reach `b` through a callback, a
trait object or a dispatch table" -- and no type checker answers it, because
it is not about types.

## Three bugs in this benchmark's own negative population

Found by loosening the population and reading what came through, which is
`AGENTS.md`'s "read the agreements too" applied to the instrument rather than
the reader. Each had been shrinking or distorting the only evidence `never`
could ever be licensed on.

**The callback guard counted a routine's own declaration.** It asks whether
the closure might be handing the tail out as a value, and answered yes
because the tail's own `export function` line sat in a file the closure
touches. `ast.ts#createInterpolation` against `ast.ts#convertToBlock` --
`createInterpolation` calls `isString` and nothing else, and the only
"mention" was a declaration two hundred lines down. That rejected **348 of
`vuejs-core`'s never-pairs, about half the population**, for no evidence at
all.

**The referee was directional where the reader is bidirectional.**
`checkSymbolEdge` tries both ends and says so: "an arrow means these two are
connected, and the diagram's sense of direction is a reading of the design
rather than a claim about who calls whom." The referee only looked forward, so
a pair where the *tail* calls the head scored as a wrong confirmation. 15 of
them on `vuejs-core` -- `transformElement` calls `mergeAsArray` on line 881,
and the forward closure from `mergeAsArray` is right to exclude it. Both
statements true; only the question was wrong. A `never` ask now requires the
reverse closure to exclude the head too.

**One cap was serving two populations.** `--unguarded` moved the *scored*
`never` count from 24 to 8, because the guard-rejected asks filled the quota
and crowded out the certifiable ones -- an instrument changing its own
reading. Capped separately, the scored population is byte-identical with the
flag and without it.

## Where the precision actually stands

With the population corrected, the cross-file rule this work added is doing
exactly its job, and every remaining wrong confirmation is somewhere else:

| | wrong confirmations | same file | **cross file** |
|---|---:|---:|---:|
| vuejs-core | 7 | 7 | **0** |
| encode-httpx + pallets-flask | 43 | 43 | **0** |
| anyhow | 26 | 26 | **0** |

**Zero across files, in all three languages.** What is left is the same-file
lenient standard, which `body.ts` documents as deliberate -- "inside one file
that is right, there is no second thing the name could mean" -- and which the
corpus now shows is not quite true: `error.rs#deref` confirms against
`error.rs#is` because its body writes `.is::<E>()`.

Applying the strict standard inside a file too was measured rather than
argued: **free on TypeScript** (7 wrong to 4, no confirmations lost) and
**a bad trade on Rust** (26 to 19, but 103 confirmations down to 76, because
`Error::construct_from_display` is how that crate is written). Left alone,
because a confirmation standard that differs per language is a bigger decision
than this measurement should make on its own, and the numbers are here for
whoever makes it.

And through all of it, in every language and every population: **0 wrong
accusations.** That is the number this project is arranged around.

**A name nothing in the file binds**: 182 Rust, 18 Python and 10 TypeScript
on the reaching pairs. A `use some::*`, a global, an ambient declaration.

**A macro**, 19 Rust. The tokens inside one are not a tree, so a call written
there is invisible and the body cannot be closed around it.

**Routines the reader does not see as routines**, 14 TypeScript on the
reaching pairs and 36 on the never pairs: an arrow
function in an object-literal property (`message: (comp) => {..}`). A `pair`
node puts its name on `key`, and `callSitesIn` reads `name` and `left`.
Deliberately left: fixing it in one reader and not the other would put
`@calls` and this walk on different populations, which is what
`docs/reading-a-grammar.md` is about.

**The closure a refutation needs.** 66 of Python's 252 forward closures closed
completely, 131 of Rust's 329, 32 of TypeScript's 181. That is the ceiling on
"never reaches" and it is why nothing accuses from it yet.
