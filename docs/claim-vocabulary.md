# The claim vocabulary: what exists, what it may say, and what is open

Written for a session picking this up cold. It is the state of #190's programme
after #187, #188, #193, #195, #198 and #199 — what the words are, what each is
*allowed* to say and why, which numbers decided that, and what is genuinely
still undecided.

`claim.ts` is the source of truth for the list. This is the reasoning around it,
which does not fit in a header.

## The one thing to understand first

**A red is an accusation, and a false one is not recoverable.** Everything below
is downstream of that. `licence.ts` opens with it, `needs.ts` is written almost
entirely as reasons not to answer, and it is why every word arrives with a
measurement rather than an argument.

The rule in `AGENTS.md`: nothing new may say *wrong* until a script has measured
how often its reader is mistaken, against a referee that shares no machinery
with it.

## The six words, and the three footings

Six words, and they do not all refute the same way. This is the distinction that
took longest to see and it is not in #190:

| word | relation | what it reads | may say wrong | how |
|---|---|---|---|---|
| `@needs` | depends | a file's import declarations | yes | **presence** |
| `@takes` | accepts | a function's parameters | yes | **absence** |
| `@returns` | produces | a function's return type | yes | **absence** |
| `@holds` | contains | a type's field list | yes | **absence** |
| `@builds` | constructs | a routine's body | yes | **presence** |
| `@feeds` | flows | a body, for a value's journey | **no** | — |

Plus `@closed` on a box (nothing outside reaches in) and `@complete` on a board
(nothing reachable is missing). Both refute from absence.

### Refuting from an absence

Available when the reader has a **closed region** — somewhere absence is
genuinely absence. A signature can be listed in full. So can a field list, or a
file's import declarations. A type missing from all of them is missing.

This is the strongest kind of check and the most fragile: it rests on the reader
not being blind, which is why `signature.ts` and `holds.ts` are mostly refusals
— an alias, a renamed import, a quoted Python annotation, a macro-generated
body. Every one of those is a place where a name might stand for something else,
and absence then proves nothing.

### Refuting from a presence

Available when the reader can find the relationship running the **other way**.
`@needs` says backwards when the import runs the opposite direction and only the
opposite direction; `@builds` says the same when the construction does.

This rests on something found rather than something missing, which makes it
robust — and it is what `@needs` has always done. **`@needs` does not refute
from an absence**: its `absent` verdict is amber, exactly as it was before claims
existed. Worth knowing, because it means "presence-only" is not a weaker footing
invented for `@builds` — it is the footing the oldest refutable word stands on.

### Never refuting

`@feeds` asks where a *value travels*, and a value can reach the far end through
a callback, a field or a queue no reader follows. Not finding the journey is
never evidence there is none. It confirms and stays quiet.

`claim.ts` admits a confirm-only word on one condition: confirming it must be
evidence of **the specific thing it asserts**. A word whose green is guaranteed
whichever way the arrow was drawn is decoration in a verdict's clothes.

## Direction, which is the one thing an author can get wrong from habit

Two conventions, and they disagree on purpose:

```
Request  --@takes-->    handler        the declaration being read is at the TO end
handler  --@returns-->  Response
build    --@builds-->   Widget         the thing doing the work is at the FROM end
RouteInfo --@holds-->   Response       the container is at the FROM end
```

`@holds` and `@builds` put the subject first. `@takes` and `@returns` put the
declaration being read last. The inconsistency was a decision: the one
hand-drawn claim in this project's board corpus drew containment holder-first
unprompted, UML has pointed whole to part for thirty years, and forcing one
convention on both would make one of them read backwards on every board.

## Licences: what a language has earned

`licenceFor` and `mayAccuse` in `licence.ts`. A language earns the right to
accuse by being measured against an independent referee over a pinned corpus.

| language | licence | referee |
|---|---|---|
| TypeScript (+ tsx, js) | yes | the TypeScript compiler |
| Rust | yes | rust-analyzer, via LSIF |
| Python | yes | pyright, via `--dependencies` |

**An unlicensed language confirms and may not accuse.** Every reader that can
say *wrong* consults `mayAccuse` at its last gate, so losing the licence costs
the accusation and nothing else — confirmations and ordinary refusals are
untouched. Finding a name is the same evidence whoever reads it; absence is the
claim about the whole of something.

That rule was applied late and it reversed an earlier decision. `signature.ts`
gated on having a *grammar*, and Python has one, so Python was the only language
shipping accusations from a reader no referee had ever seen — while getting an
ordinary Python signature wrong (#195). #198 re-licensed it, and the next
section is what that cost.

### What Python is allowed to accuse about, and what stays withheld

Settled by #198, and worth reading as four separate answers rather than one:

| word | Python may accuse | on what evidence |
|---|---|---|
| `@needs` | yes | 12,693 dependency edges over five repositories: 41 missed, **0 invented** |
| `@holds` | yes | 2,177 field asks, 0 missed, 0 invented; refuses a quarter of them |
| `@takes` / `@returns` | yes | 4,002 type names in 1,543 functions, 0 missed |
| `@builds` | **no** | not a licence question — Python spells making one of something as a call, so `constructs.ts` withholds it before any licence is consulted |

The three yeses are three separate measurements against three unrelated
referees, which is the only reason one licence entry covers four words. What
the licence still does *not* have is a per-relation axis: if a fourth word
arrives whose Python reader has not been measured, it inherits an accusation it
did not earn. That is the hole #190 calls the licence grid, and Python's licence
is the thing that finally makes it worth building.

The cost is on the record and it is not small. Before the licence, the Python
signature reader withheld all 1,543 functions it read, 1,404 of them for no
reason but the missing licence. It now refutes those and goes on withholding
139 — 71 aliased, 68 quoted. `@holds` refuses 25.4% of Python asks, all of them
quoted annotations, and that number did not move.

## The measurement harness

Every number in #187, #188, #190 and #199 comes out of one of these. They print
and never fail.

| command | what it answers |
|---|---|
| `npm run measure:vocabulary` | how much of a diagram can be judged at all — failed claims, arrow prose, relation census |
| `npm run measure:holds` | can the field reader be trusted with a red |
| `npm run measure:constructs` | can the construction reader be trusted to say backwards |
| `npm run measure:signature` | the same for parameters and return types |
| `npm run measure:licence` | reproduces the per-language licence numbers — `--only=python` for one |
| `npm run measure:dataflow` | what following a value through one body buys, confirming and refuting |
| `npx tsx scripts/probe-generative.mts` | draws boards of unseen code and counts what could not be said |

The pattern in all of them is a **referee**: count the shape one way, count it
again by a completely different mechanism, report the disagreement. It is not
ceremony. Between them these scripts have found nine reader bugs and eleven
referee bugs, and not one was reachable by thinking about it.

### The corpus

Code, taken as it sits on disk rather than pinned, because these are dormant
checkouts: `src`, `scripts`, `rust-test`, `~/orangutan`, `~/mundane`,
`~/infrarouter`, `graphify/graphify`. Four languages throughout, never one — a
detector that misses a language's spelling produces a confident wrong answer,
which has happened twice here.

Boards: the real ones, excluding worktree copies under `.claude` and test
fixtures. That is ~20 of the 1,902 `.excalidraw` files on the machine this was
written on; the rest are the same thirteen boards at six different ages.

## Where it stands

```
npx tsx scripts/probe-generative.mts     — four boards of code no board here describes
  arrows carrying a claim    86%     (was 43% before @holds and @builds)
  arrows with no word at all   5     (was 26)
```

Coverage of what the code says, from `measure:vocabulary`: **17.2%** against
everything the syntax shows, **21.2%** against relationships whose both ends are
declared in the same repository. The first counts every `console.log` and
`.map()`, so it is a floor rather than an estimate.

Still wordless: `invokes` (#189), `conforms`, `accesses`.

## Seven times a measurement contradicted the design

Kept because the pattern is the point: five of the seven came from building one
word or one reader, not from reviewing the design.

1. **The substrate was empty.** #190's first draft proposed graphify as the
   fact supplier on the strength of 8,167 `contains` edges. `contains` there is
   one callable lexically inside another. The relation actually needed had 22
   edges in this repo and **0 in Python anywhere**.
2. **`constructs` was undercounted twentyfold.** The census read it at 0.3% of
   all code and it was heading for the cut. JSX was not being counted; `<X />`
   is a construction, and in tsx the figure went from 100 to 2,270 (#197).
3. **The sorts layer was built as silence.** A claim between a type and a
   routine was made to withhold quietly — and #190's own text says a category
   error should be *caught* "rather than silently withheld by a checker that was
   never going to answer". It now fails the build as a garbled claim.
4. **Python was accusing when the issue said it could not.** #190 called Python
   structurally unable to refute. `signature.ts` never consulted a licence, so
   Python was the one language accusing unmeasured (#195).
5. **The referee was the thing that was wrong, twice.** Measuring Python
   (#198) turned up four reader bugs and two harness bugs, and the harness ones
   were the expensive pair: resolving the referee's paths through `realpath`
   renamed a symlinked directory and manufactured 95 disagreements the reader
   had right, and reading a file pyright had never bound as a file with *no
   imports* turned the referee's silence into the reader inventing everything in
   it. A referee is a program somebody wrote, and it can be read wrongly.
6. **Fixing recall is how precision breaks.** The same measurement, in
   sequence: the Python reader looked an absolute import up only at the
   repository root, which lost every arrow in flask's six example projects.
   Making it walk up from the file fixed all eleven — and made `import typing as
   t` beside `src/flask/typing.py` invent sixteen edges in one line, because it
   had started shadowing the standard library. Neither half was visible without
   the other, and running the measurement once would have shipped one of them.
7. **#203's prediction was wrong, and backwards.** It said dataflow would make
   confirming *dramatically* better and refuting only *slightly* better, which
   is why it was written as a note rather than a programme. Measured (#208):
   confirming gained **4.0%** of the flows in the corpus and refuting reached
   **11.5%** of all values. The ratio is the opposite of the one predicted, and
   the shape of it is one number: **41.7% of values escape by being handed to a
   routine** — which is #189, not dataflow.

`renders` was also raised as a possible missing relation and turned out not to
be one: `<MenuContent />` is a routine making a MenuContent, which is `@builds`.

## Open, in the order worth doing

1. **#189 — `invokes`.** Bigger than it reads: cross-file call resolution is
   also the substrate for everything in #203, so it is a call graph rather than
   a word. #198 was its blocker and is now done, so its largest population is a
   language that can refute.
2. **The licence grid**, which #198 turned from a someday into a hole with a
   name. See below.
3. **#203 — the engine has no notion of a value.** Dataflow, points-to, escape
   analysis. Its prediction has been measured and did not hold, in the direction
   that makes it *more* interesting rather than less — see item 7 above and
   `npm run measure:dataflow`. What that changes is the order: the escaping is
   concentrated in one shape, and closing that shape is #189. So #203 is worth
   revisiting **after** the call graph rather than instead of it, and the number
   to beat is 11.5%.
4. **#190's layer 2.** The relation list is settled as-is by the owner. The one
   thing worth recording there is the three footings above — the table's `may
   accuse` column reads as a yes/no and it is not.

**#198 — Python's licence** is done: pyright, five pinned repositories, 12,693
dependency edges, 41 missed and 0 invented. What it bought is above, and
`surveyScope` will now draft a Python board instead of refusing the scope.

## What is deliberately not being built

- ~~**A per-(relation, language) licence grid.**~~ This was the one thing on
  this list with a stated trigger — "build it when a third relation or Python's
  licence makes the holes worth naming" — and #198 pulled it. One `Licence`
  entry now speaks for four words on the strength of three separate
  measurements, and nothing in the type says which. The next word to arrive
  inherits a Python accusation it has not earned, silently, which is #195
  again with a different reader. It has moved to the open list above.
- **`@type-arg`**, despite type arguments being the second most common
  relationship in all code. Almost all of it is `Vec<T>`, `Promise<T>`,
  `list[str]`, which nobody draws as two boxes.
- **A relation for "this function fits that field's function-pointer type"**,
  which is what the orangutan arrow actually wants. Real, and probably not worth
  a word.

## A note on that orangutan arrow

`orangutan/docs/diagrams/route-registration.excalidraw` carries
`RouteInfo --[parameter @takes]--> hello_handler` and reports red. #188 tells
this as an authoring failure — somebody reaching for the nearest word and being
accused. **It is not: it is the owner's test that a false claim goes red.**

The red is correct and should stay. `@takes` is false there — `hello_handler`
takes a `&Request`. And `@holds` is not true either, because the far end is a
function rather than a type, which is now caught as a category error.

Worth knowing before reading #188's framing, and worth not "fixing".
