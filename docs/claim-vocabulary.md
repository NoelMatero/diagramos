# The claim vocabulary: what exists, what it may say, and what is open

Written for a session picking this up cold. It is the state of #190's programme
after #187, #188, #189, #193, #195, #198 and #199 — what the words are, what each is
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

## The seven words, and the three footings

Seven words, and they do not all refute the same way. This is the distinction
that took longest to see and it is not in #190:

| word | relation | what it reads | may say wrong | how |
|---|---|---|---|---|
| `@needs` | depends | a file's import declarations | yes | **presence** |
| `@takes` | accepts | a function's parameters | yes | **absence** |
| `@returns` | produces | a function's return type | yes | **absence** |
| `@holds` | contains | a type's field list | yes | **absence** |
| `@builds` | constructs | a routine's body | yes | **presence** |
| `@calls` | invokes | a routine's body, and what its names are bound to | yes | **presence** |
| `@feeds` | flows | a body, for a value's journey | **no** | — |

Plus `@closed` on a box (nothing outside reaches in) and `@complete` on a board
(nothing reachable is missing). Both refute from absence.

The **may say wrong** column is about the word, not about any particular board.
Whether it may say so *here* is a second question with its own answer per
language — [the grid](#the-grid) below.

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

### The one word whose fact is not in one file

`@calls` is the exception to something every other reader here relies on. A
signature, a field list and a file's imports are all local: read the file and
you have the whole answer. `foo()` is a **name**, and which `foo` it means is a
question about bindings that live somewhere else.

So its reader is two layers, and the second is where it goes wrong: find the
call sites, then work out what each called name is bound to. Half of `calls.ts`
is the second layer, and the measurement's job was to find out how often that
layer can answer at all.

`claim.ts` admits a confirm-only word on one condition: confirming it must be
evidence of **the specific thing it asserts**. A word whose green is guaranteed
whichever way the arrow was drawn is decoration in a verdict's clothes.

## Direction, which is the one thing an author can get wrong from habit

Two conventions, and they disagree on purpose:

```
Request  --@takes-->    handler        the declaration being read is at the TO end
handler  --@returns-->  Response
build    --@builds-->   Widget         the thing doing the work is at the FROM end
run      --@calls-->    render         the caller is at the FROM end
RouteInfo --@holds-->   Response       the container is at the FROM end
```

`@holds`, `@builds` and `@calls` put the subject first. `@takes` and `@returns` put the
declaration being read last. The inconsistency was a decision: the one
hand-drawn claim in this project's board corpus drew containment holder-first
unprompted, UML has pointed whole to part for thirty years, and forcing one
convention on both would make one of them read backwards on every board.

## Licences: what a word has earned, in what language

`licenceFor` and `mayAccuse` in `licence.ts`. A **word** earns the right to
accuse **in a language** by being measured against an independent referee. Two
axes, and until #207 there was only one.

**An unlicensed pair confirms and may not accuse.** Every reader that can say
*wrong* consults `mayAccuse` at its last gate, so losing a licence costs the
accusation and nothing else — confirmations and ordinary refusals are untouched.
Finding a name is the same evidence whoever reads it; absence is the claim about
the whole of something.

That rule was applied late and it reversed an earlier decision. `signature.ts`
gated on having a *grammar*, and Python has one, so Python was the only language
shipping accusations from a reader no referee had ever seen — while getting an
ordinary Python signature wrong (#195). #198 re-licensed it, and the grid below
is what that then made necessary.

### The grid

Written by hand, and **checked**. `tests/engine-licence.test.ts` reads this
table out of this file and compares every square against `licence.ts`, so the
two cannot disagree without the suite going red — a flipped yes, a dropped row
and a column nobody taught it about all fail by name. The code is still the
authority where they differ, and `npm run measure:licence` prints the live grid
at the end of its run.

Hand-written rather than generated on purpose: the table is three lines of a
section that is mostly prose, and prose is the thing a person came here for.
What it may not do is drift.

| word | TS / TSX | JavaScript | Rust | Python | what measured it |
|---|---|---|---|---|---|
| `@needs` | yes | yes | yes | yes | a compiler, five pinned repositories per language |
| `@takes` | yes | **no** | yes | yes | a text scan of the same signatures |
| `@returns` | yes | **no** | yes | yes | the same run |
| `@holds` | yes | **no** | yes | yes | a text scan of the same field lists |
| `@builds` | yes | **no** | yes | **no** | a text scan of the same routine bodies |
| `@calls` | yes | **no** | yes | yes | a text scan that bounds each routine and reads its calls |

`@feeds` is not on it. It never accuses, so there is nothing to license.

**Every no is a finding rather than a design**, and none of them was visible
until the squares had to be filled in one at a time.

`measure:constructs` asks `@builds` about Python **0 times over 442 files**,
because Python spells making one of something as an ordinary call. There is no
measurement, so there is no permission. `constructs.ts` refuses Python before
any licence is consulted anyway, so nothing changes today — what changed is that
the square used to read *yes*.

**JavaScript is the one that was not already known, and it was not free.** It
lives inside the TypeScript licence, and that licence's *imports* were measured
over five repositories — but `measure:holds`, `measure:signature` and
`measure:constructs` ask JavaScript **0 questions between them**: 21 files, 51
functions, not one type name and not one construction. `measure:calls` asks it
**2**. Five squares were saying yes on TypeScript's numbers.

`@holds` was inert there, because JavaScript writes no type on a field and the
reader refuses before the licence is reached. `@takes` was not. A JavaScript
function declares no parameter types at all, so every parameter claim on one read
as an *absence* — and `measure:signature` reports the reader was prepared to
refute **51 of 51** JavaScript functions in the corpus, on a referee that has
never seen the language. Those are withheld now. `@builds` is the remaining
gap rather than a finding: `new Foo()` is a construction the reader could read
in JavaScript, and there is simply none in the corpus to ask about.

**`@calls` is the square that proves the grid rather than illustrating it.** It
did not exist when this section was written. #189 shipped it while the grid was
in review, reading the old per-language gate — so from the day it merged, a
JavaScript call arrow could be told to **turn round** on a reader that had been
asked two questions in JavaScript. Nothing structural stopped it: `@holds` is
inert in JavaScript because the reader refuses a language with no field types
long before the licence is reached, and a JavaScript call is an ordinary call.
That is #195 exactly — a reader shipping an accusation it inherited — four days
later, in a new word, caught by a type rather than by somebody noticing.

**Rust's `@calls` square needed a wider corpus before it could say yes.** The
default `measure:calls` corpus asks Rust 36 questions, and a zero in the miss
column over 36 asks is not evidence of much. So that row is measured over the
two repositories the dependency licence already pins — ripgrep and anyhow at
their recorded commits — where Rust is a different language: recall falls from
94.4% to **66.0%**, and two thirds of the refusals are `macro`.

Widening it found a sixth referee bug of the kind #189 found five of, and the
same one twice over. Rust's raw strings span lines and honour no escape, so the
referee never closed one — ripgrep writes every flag's help text as a multi-line
`r#"..."#`, and the English in them read as code. `enabled`, `files` and `dot`
are ordinary words and each is also a routine ripgrep declares exactly once, so
five calls were credited to a documentation method and counted against the
reader. Blanking raw strings the way template literals are already blanked took
the misses from 8 to 4, and changed nothing in the default corpus, which has
none.

The four that remain were each read, and **the reader is right about all four.**
They are the referee asking about a name it cannot place: `Ok` is anyhow's own
`pub fn Ok` as well as the prelude variant, and the file calling it imports the
one it does not mean; `trim_line_terminator` is declared both as a free function
and as a method, and the referee credited the call to the wrong one. Nothing
accused and nothing invented across all 574, which is what an accusation rests
on; the recall is the cost.

The numbers behind each square, and the command that reproduces it, are in
`relations` in `licence.ts`. In short, for Python: 12,693 dependency edges with
41 missed and 0 invented; 2,177 field asks with 0 missed; 4,002 type names in
1,543 functions with 0 missed; 5,525 calls in 683 files with 0 missed and 0
invented, refusing 7.1%. Four separate runs against four unrelated referees,
which is exactly why one entry saying "yes" for all of them was the wrong
shape.

### What an unlisted square does

**It may not accuse, and it does not compile.** Both, decided at #207.

`relations` is an exhaustive `Record`, so adding a seventh word to
`ARROW_CLAIMS` stops the build in every licence and in the test that pins the
grid, until somebody writes down what measured it. The answer is allowed to be
"nothing" — it is just not allowed to be silence. And `mayAccuse` still answers
*no* to anything it cannot find, because a compile error only catches the person
adding the word, and a cast walks past a type.

Defaulting a blank square to *yes* was never live. A grid whose empty square
means "may accuse" is the bug it exists to prevent, wearing a table.

`@closed` and `@complete` are not on the grid. They accuse from an absence too,
and they read the imports — the same reader `@needs` uses and the same corpus
measures — so they ask `licenceFor` about a path, which is that question in the
form they can put it.

### What Python's licence cost

The cost is on the record and it is not small. Before the licence, the Python
signature reader withheld all 1,543 functions it read, 1,404 of them for no
reason but the missing licence. It now refutes those and goes on withholding
139 — 71 aliased, 68 quoted. `@holds` refuses 25.4% of Python asks, all of them
quoted annotations, and that number did not move.

What #207 cost is on the record too, and it is one number: 51 JavaScript
functions that `@takes` would have refuted are withheld instead. No board in the
corpus changes verdict — `npm run measure:vocabulary` still reports 1 failed
claim across 17 boards, and it is the same Rust one — and `measure:holds`,
`measure:constructs` and `measure:signature` report 0 missed and 0 invented as
before.

## #189's decision: refutable, and the number that decided it

#189 gated `@calls` on a measurement rather than sequencing it, because a call
is not obviously refutable on a closed region the way a field list is. Two
outcomes were named in advance and both were acceptable: **refutable**, or
**confirm-only like `@feeds`**.

It shipped **refutable**. The number:

```
npm run measure:calls          7 trees, 1,619 files, 10,764 routines
  MISSED    referee saw the call, reader said absent        0
  ACCUSED   referee saw the call, reader said backwards     0
  INVENTED  reader confirmed a call that is not there       0
```

Recall and refusal, per language, over 6,654 calls between routines the
repository declares:

| language | asked | recall | refused | cross-file recall |
|---|---:|---:|---:|---:|
| python | 5,525 | 92.9% | 7.1% | 87.4% |
| ts | 780 | 97.9% | 2.1% | 96.1% |
| tsx | 311 | 87.5% | 12.5% | 80.7% |
| rust | 36 | 94.4% | 5.6% | 83.3% |

Python is 83% of the population, which is the right shape: it is the language
the census says most of the calls are in and the one where a call is hardest to
place statically. A measurement on TypeScript alone would have produced an
encouraging number and a word that refuses on four fifths of real code.

**The refusals are not concentrated in one language and they are not
mysterious.** `unbound` (a name a wildcard import, a global or an ambient
declaration brought in) and `unplaced` (a name from a module that resolved to no
file here) are two thirds of them. Neither is a reader bug; both are a name the
text genuinely does not place.

### The population, and the honest thing done about it

The population is calls **between routines exactly one file in the repository
declares**, which is #189's own definition — a call an arrow could point at —
with the ambiguity removed rather than guessed at. 299 names declared in more
than one file were left out and counted, because asking about one of two answers
would score a correct refusal as a miss.

Calls written on a **receiver** are reported separately and are not in the
recall figure: 1,995 of them. That is not a concession, it is the referee's own
limit stated out loud. A text scan can say with certainty that `foo()` is a call
to whatever `foo` is; it cannot say the first thing about whose `resolve` is
meant in `path.resolve()`. The reader refused 1,245 of those and confirmed 622,
and it should — that is dynamic dispatch, the first hazard #189 lists.

### What the measurement found, which is the reason it exists

Nine bugs, and not one was reachable by thinking about it. Four in the reader:

1. **Every import counted as a local declaration.** An import *looks* exactly
   like a declaration to the rule `parse.ts` states — `import { foo }` is a node
   with a `name` field — so every imported name was ambiguous with itself: 217
   refusals in `ts`, 156 in `tsx`, and **zero** cross-file calls confirmed in
   either. The word looked impossible in TypeScript and the cause was one
   missing exclusion.
2. **A forwarded name was an absence.** A name imported from a file that
   re-exports it — `from graphify.extract import extract_objc` — read as
   `absent`. 250 calls in one repository, written in plain sight, each one half
   of a false `backwards`.
3. **`foo::<T>()` read as a member access**, so 66 Rust calls came back
   `computed`: a doubt about a name that was right there in the text.
4. **An interface's own field counted as callable.** `interface Props {
   registerRef: ... }` declares a name nothing in the file can call, and
   counting it made a call to an *imported* `registerRef` read as "this file's
   own" — a definite no, on a call three lines below the interface.

Five in the referee, which is the pattern #198 recorded and this repeated:

5. **Blanking C block comments in Python.** A `.graphifyignore` test writes the
   pattern `/*` into a file, which opened a comment with no end for two thousand
   lines. Every `def` in between vanished, one routine appeared to span the rest
   of the file, and its calls were credited to the wrong routine — 38 of the 45
   disagreements then outstanding.
6. **An arrow function with an expression body never closed.** `const
   customComparer = () => true;` stayed open until the next routine and was
   credited with everything in between.
7. **A template literal read as code.** A spinner's CSS keyframes put
   `transform: rotate(45deg)` in one, and `rotate` is declared on the other side
   of that monorepo.
8. **An object literal's shorthand method read as a call.** `dispose() { .. }`
   is a definition and looks exactly like a call to a text scan.
9. **`db.$count(..)` read as a bare call to `count`**, because the word boundary
   falls between the `$` and the name and the receiver disappeared.

The last five are all the same mistake in five costumes: **the referee cannot
tell which of two same-named things is meant, and asked anyway.** It now does
not ask when the calling file binds the name itself.

## The measurement harness

Every number in #187, #188, #190 and #199 comes out of one of these. They print
and never fail.

| command | what it answers |
|---|---|
| `npm run measure:vocabulary` | how much of a diagram can be judged at all — failed claims, arrow prose, relation census |
| `npm run measure:holds` | can the field reader be trusted with a red |
| `npm run measure:calls` | can the call reader be trusted to say backwards, and how often it can answer |
| `npm run measure:constructs` | can the construction reader be trusted to say backwards |
| `npm run measure:signature` | the same for parameters and return types |
| `npm run measure:licence` | reproduces the per-language licence numbers — `--only=python` for one |
| `npm run measure:dataflow` | what following a value through one body buys, confirming and refuting |
| `npm run measure:licence` | reproduces the per-language dependency numbers, then prints the whole (word, language) grid — `--only=python` for one |
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
  arrows carrying a claim    90%     (was 43% before @holds and @builds)
  arrows with no word at all   3     (was 26)
```

Coverage of what the code says, from `measure:vocabulary`: **57.8%** against
everything the syntax shows, **56.1%** against relationships whose both ends are
declared in the same repository. The first counts every `console.log` and
`.map()`, so it is a floor rather than an estimate.

That figure was **17.2%** in this document until #189, and two thirds of the
jump is not `@calls`. `measure-vocabulary.mts` keeps its own hand-maintained
table of which relation has a word, and `@holds` and `@builds` were never added
to it — so the census had been reporting the coverage of a three-word vocabulary
since #188. Corrected, the honest sequence is:

| | everything | drawable |
|---|---:|---:|
| as reported before #189 | 17.2% | 21.2% |
| with `@holds` and `@builds` counted at last | 35.3% | 32.6% |
| with `@calls` | **57.8%** | **56.1%** |

`invokes` was 61,499 of the 273,694 relationships the census reads, so it is the
largest single thing any one word here has ever covered. It is also the fourth
time a hand-maintained list in this programme went stale silently, which is why
the probe's own two lists were replaced with a shape rule in the same change.

Still wordless: `conforms`, `accesses`. `invokes` was the largest of the three
and #189 gave it `@calls`.

## Ten times a measurement contradicted the design

Kept because the pattern is the point: eight of the ten came from building one
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
   the shape of it is one number: **42.4% of values escape by being handed to a
   routine** — which is #189, not dataflow.
8. **One more abstraction moved both numbers, which is the argument for a
   framework.** The first reading of #208 modelled nothing but locals, so
   `v.push(widget); use(v[i])` — #203's own example — was invisible. Adding a
   single abstraction, a collection as one thing with the index deliberately
   forgotten, took confirming from 4.0% to **5.9%** and refuting from 11.5% to
   **13.0%**. It also surfaced two bugs that had nothing to do with
   collections, so the first reading was understating both. The finding is not
   the 1.5 points: it is that the second abstraction cost an afternoon and
   generalised, which is what a framework means.
9. **The call graph was worth a fifth of what the questions it raised were.**
   With #189 merged, resolving a callee and asking whether it keeps its
   argument took refuting from 13.0% to **19.1%** — and only **1.1 points of
   that is the call resolution**. 279 values were freed by reading a callee's
   body. The other ~1,240 came from two rules the exercise *forced*, both of
   them local: a property read hands out the property rather than the object,
   and arithmetic makes a new value out of its operands. Without those, no
   callee ever "keeps" its argument — `return x.length` is the commonest shape
   of a routine that only looks at one — so the interprocedural question read
   zero for everybody, and getting it to answer at all meant getting value
   semantics right first.

   The other half of that finding: **65.1% of calls still cannot be resolved to
   a routine in the corpus**, most of them builtins and library calls. `@calls`
   made a call's name resolvable; it did not make the world enumerable.

7. **The hardest word was the one that refused least.** #189 predicted `@calls`
   might have to ship confirm-only, because a call is not obviously refutable
   the way a field list is — dynamic dispatch, `getattr`, callbacks, macros, all
   real. It refuses **7.1%** of Python and **2.1%** of TypeScript, which is
   lower than `@holds` refuses Python (25.4%), a word nobody doubted. The five
   hazards are real and they are rare, and no amount of listing them said which.

   The reverse also held, and it is the same lesson twice: the thing that nearly
   sank the word was not a hazard on that list at all. It was counting an
   `import` as a local declaration, which made every cross-file call in
   TypeScript unanswerable and had nothing to do with calls.

10. **The closed region in `@calls` is real and nearly empty.** #217 names the
    largest hole in the vocabulary: `@calls`, `@builds` and `@needs` refute from
    a **presence**, so an arrow drawn between two things that are simply
    unrelated gets silence — and `invokes` is the biggest population there is.
    The escape offered itself. A routine's call sites are syntactically
    enumerable, so if *every* call in a body resolved, the call set is complete
    and "does not call" becomes refutable from an absence, on a signature's
    footing.

    `measure:closed-bodies` reports the refusal reasons per **body** rather than
    per ask, which is what the claim needs, and the answer is no. **15.1%** of
    the 11,360 bodies that call anything have a call set the reader can
    enumerate completely — and it is in the wrong place: **33.3%** of bodies of
    five lines or fewer close, **0.5%** of bodies over fifty, 4 of 853. A
    refutation available only on short functions is not worth a word, because
    the arrow somebody draws between two large routines is the one it would
    stay silent on.

    The reason is a single reason, which is why no amount of reader work fixes
    it: `receiver` is the *sole* blocker in 2,772 open bodies, 28.8% of them and
    more than every other reason combined. `x.foo()` is how ordinary code is
    written and placing it means knowing the type of `x`. That is a type system,
    not a claim word — the same wall #203 names.

    Recommended against, and the per-site figure is the trap worth recording:
    **30.6%** of individual call sites resolve, which reads twice as encouraging
    as the per-body number. Closure is conjunctive. One unplaced call in a body
    of twenty opens the body, and a measurement that reported sites instead of
    bodies would have argued for building this.

    Two of the three numbers above were wrong on the first run, and the referee
    found both. The reader counted TypeScript interface and Rust trait method
    **signatures** as routines — parameters, no body — so 1,618 declarations
    that cannot call anything were being counted as bodies that call nothing.
    And the comparison paired two reader bodies of one name against one of the
    referee's, blaming the reader for a disagreement the pairing invented.

`renders` was also raised as a possible missing relation and turned out not to
be one: `<MenuContent />` is a routine making a MenuContent, which is `@builds`.

## Open, in the order worth doing

1. **The licence grid**, which #198 turned from a someday into a hole with a
   name and #189 has now widened: one `Licence` entry speaks for **seven** words
   on the strength of four separate measurements. See below.
2. **#203 — the engine has no notion of a value.** Dataflow, points-to, escape
   analysis. Its prediction has been measured and did not hold, in the direction
   that makes it *more* interesting rather than less — see items 7 and 8 above
   and `npm run measure:dataflow`. Two abstractions are built, both generalised,
   and the number to beat is **19.1%**.

   What it must not be revisited as is a case-by-case reader. The shapes are
   unbounded and the lists that recognise them go stale silently — which is the
   fourth item below, and has now happened four times in this programme.

   `@calls` is a call checker rather than a call graph, so this took a build on
   top of `bindingsIn` rather than a re-run — and the build is done and
   measured (item 9). What it says is that the call graph was the *smaller*
   half of its own question, and that two thirds of calls still resolve to
   nothing this corpus holds.
3. **#190's layer 2.** The relation list is settled as-is by the owner. The one
1. **#203 — the engine has no notion of a value.** Dataflow, points-to, escape
   analysis. #203's own prediction — confirmation much better, refutation only
   slightly — is being measured rather than argued at #208, which is the right
   order and is not settled here. What is settled is that `@calls` does *not*
   deliver the substrate #189 hoped it might: the resolver there answers "is
   this call to that file's routine", not "what does every call in this
   repository point at", and a call graph is the second question.
2. **#190's layer 2.** The relation list is settled as-is by the owner. The one
   thing worth recording there is the three footings above — the table's `may
   accuse` column reads as a yes/no and it is not.

**#198 — Python's licence** is done: pyright, five pinned repositories, 12,693
dependency edges, 41 missed and 0 invented. What it bought is above, and
`surveyScope` will now draft a Python board instead of refusing the scope.

**#207 — the licence grid** is done. It was argued for as bookkeeping — nothing
was accusing on evidence that did not exist — and stopped being bookkeeping
before it landed, because #189's `@calls` arrived in between and was accusing in
JavaScript on two asks. `mayAccuse` now takes the word as well as the language,
two squares are a stated *no*, six more are a stated *no* for JavaScript, and
the next word cannot be added without somebody answering for it in every
language.

## What is deliberately not being built

- ~~**A per-(relation, language) licence grid.**~~ Built at #207. It was the one
  thing on this list with a stated trigger — "build it when a third relation or
  Python's licence makes the holes worth naming" — and #198 pulled it. See
  [the grid](#the-grid) above.

  It was argued for as insurance: nothing was accusing wrongly when it was
  written, and the hole was the *next* word. The next word arrived before the
  grid landed. #189 shipped `@calls` reading the old per-language gate, and
  `@calls` had earned its Python accusation by being **measured** — 92.9% recall,
  zero false accusations — while the licence would have granted it either way,
  in JavaScript too, on two asks. So the insurance argument never had to be
  taken on trust.
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
