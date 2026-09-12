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
| rust | 983 | 423 (43.0%) | **288 (29.3%)** | 135 / 695 | 88 / 695 |

"multi-step" is every pair two or more calls apart, which is the population
this was built for. Per depth, written `before → after` out of the asks at
that depth:

| steps | typescript | python | rust |
|---|---|---|---|
| 1 | 134 → 131 (of 139) | 312 → 262 (of 312) | 288 → 200 (of 288) |
| 2 | 45 → **99** (of 115) | 29 → **56** (of 78) | 75 → 53 (of 156) |
| 3 | 33 → **81** (of 95) | 7 → **19** (of 37) | 26 → 24 (of 105) |
| 4 | 13 → **60** (of 69) | 2 → **8** (of 21) | 10 → 7 (of 96) |
| 5 | 5 → **43** (of 55) | 0 → **1** (of 8) | 4 → 1 (of 116) |
| 6 | 2 → **38** (of 72) | 0 → 0 (of 1) | 20 → 3 (of 222) |

**Arrows that go green and should not.** This is the number Rust's row above
is the price of.

| | before | after |
|---|---:|---:|
| typescript | 0 of 384 | 0 of 384 |
| python | 8 of 792 | **1 of 792** |
| rust | 60 of 1,572 | **9 of 1,572** |

As precision: Rust 87.6% → **97.0%**, Python 97.8% → **99.7%**, TypeScript
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

**Rust confirms 135 fewer arrows than it used to. 51 of those 135 were
wrong, and 84 were correct arrows that lost their green.** That is one trade,
not two numbers: the rule that stops
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
files. Anybody who would rather have Rust's 135 greens back, and its 51 wrong
ones with them, changes that argument to `false`.

**Time: 0.4 ms an arrow.** Measured over 715 asks on `vuejs-core`, 4,874
routines, warm -- `measure:reach` prints it. 0.3 seconds for all 715.

The walk is asked in two places and nowhere else: where the one-file search
failed to confirm a symbol-anchored arrow, and where `@calls` is about to
accuse. Never on an arrow that already passed. Bodies are read at most once
per file per check (`ReachCache`).

`npm run check:drift` on this repository's fourteen boards: 1.57s before,
1.62s after, and byte-identical output -- none of those boards has an arrow
that needed the walk, which is the other half of the cost answer. It costs
nothing where it is not needed.

## What is still out of reach

**A receiver nothing typed**, which is most of it. Of the refusals on pairs
that do reach: 476 of Rust's 695, 69 of Python's 111, 50 of TypeScript's 93.
Of the refusals on pairs that do not: 988 of Rust's 1,552, 467 of Python's
779, 204 of TypeScript's 360. `self.inner.by_ref()` in `anyhow` is the
shape --
`inner`'s type is declared on a struct in *another file*, and `resolution.ts`
reads one file. A cross-file field-type lookup is the named next step and this
is the number that would justify it.

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
