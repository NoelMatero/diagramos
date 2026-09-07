# The claim vocabulary: what exists, what it may say, and what is open

Written for a session picking this up cold. It is the state of #190's programme
after #187, #188, #189, #193, #195, #198, #199 and #216 — what the words are, what each is
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

## The nine words, and the three footings

Nine words, and they do not all refute the same way. This is the distinction
that took longest to see and it is not in #190:

| word | relation | what it reads | may say wrong | how |
|---|---|---|---|---|
| `@needs` | depends | a file's import declarations | yes | **presence** |
| `@takes` | accepts | a function's parameters | yes | **absence** |
| `@returns` | produces | a function's return type | yes | **absence** |
| `@holds` | contains | a type's field list | yes | **absence** |
| `@builds` | constructs | a routine's body | yes | **presence** |
| `@calls` | invokes | a routine's body, and what its names are bound to | yes | **presence** |
| `@accesses` | accesses | a type's member list — **and** a routine's body | yes | **absence**, at the type end only |
| `@conforms` | conforms | a type's base list, where the language writes one | yes | **absence** |
| `@feeds` | flows | a body, for a value's journey | **no** | — |

Plus `@closed` on a box (nothing outside reaches in) and `@complete` on a board
(nothing reachable is missing). Both refute from absence.

The **may say wrong** column is about the word, not about any particular board.
Whether it may say so *here* is a second question with its own answer per
language — [the grid](#the-grid) below. `@conforms` is where that distinction
stops being a technicality: the word may say wrong, and in Rust it never will,
because what a Rust type implements is not written on the type.

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

### The one word whose two ends are on different footings

`@accesses` is the first word here that reads two things rather than one, and
they cannot be believed to the same degree. `Renderer --[width @accesses]-->
Config` says this routine reads that member off that type, and the two halves of
that sentence have different evidence behind them:

- The **type** end is a declaration. A member list is a closed region, so a type
  that does not declare `width` refutes the arrow — exactly the footing
  `@holds` stands on, and the value of the word: rename a field and every
  diagram still naming the old one goes red the turn the rename lands.
- The **routine** end is a body. Working out what a body touches needs every
  receiver's type, which needs the whole program — the may-analysis #203
  measured and rejected. Not finding the access is not evidence there is none,
  so this end confirms and is otherwise silent.

So the word refutes from one end and stays silent at the other, and that is not
a compromise between the two footings above. It is the split `@builds` already
uses one relation over: the accusation rests on what was found, and the absence
beside it is never a finding.

Confirming needs **both** halves, which is `claim.ts`'s admission rule applied
to a word with two of them. "Config declares `width`" would come back green
whatever routine sat at the far end. "This routine writes `.width`" says nothing
about Config. Together they are the strongest evidence available without a type
checker.

It is also the only word whose claim takes an **argument**: the member name,
written on the arrow's label. An `@accesses` arrow that names no member can be
read at neither end, so it is reported as garbled rather than withheld quietly.

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

### The one word whose footing changes with the language

Every other word here stands on the same ground in every language it is licensed
for. `@conforms` does not, and that is a fact about the languages rather than
about the reader (#216).

- **Python and TypeScript write it on the declaration.** `class Handler(Base)`,
  `class A extends B implements C`, `interface X extends Y`. The base list is
  closed: read the declaration and "this is not one of that" is a statement
  about the whole of it. Same footing as `@holds`, and it may accuse.
- **Rust writes it somewhere else entirely.** `impl Trait for Type` is a
  free-standing item that may sit in **any file in the crate**, next to neither
  the trait nor the type. Reading `struct Type` tells you nothing about what it
  implements, so there is no region to close and an absence in one file proves
  nothing. It confirms an `impl` it can see and reports the arrow unread
  otherwise.

That is what makes the grid's two axes load-bearing rather than tidy. Every
other **no** in it means *nobody has run the numbers*; this one means *the fact
is not in the file*, and no measurement of any reader would change it. The
refusal is reported in its own words — `region-is-the-crate` — because
"unmeasured" would be a different and untrue sentence.

Getting this one wrong in the permissive direction would put a false red in the
language this project has the least of and understands worst, which is the
reason it was worth a per-language answer rather than a global one.

One more thing it does not do, and it is the opposite of `@holds`: **type
arguments are not bases.** `class Store extends Cache<Entry>` says Store is one
of Cache and nothing about Entry, where a field typed `Vec<RouteInfo>` really
does hold a RouteInfo. `type-argument` is 12.6% of all code and deliberately
outside this vocabulary, and reading through here would have answered it with
the wrong word.

## Direction, which is the one thing an author can get wrong from habit

Two conventions, and they disagree on purpose:

```
Request  --@takes-->    handler        the declaration being read is at the TO end
handler  --@returns-->  Response
build    --@builds-->   Widget         the thing doing the work is at the FROM end
run      --@calls-->    render         the caller is at the FROM end
RouteInfo --@holds-->   Response       the container is at the FROM end
Handler  --@conforms--> Base           the subtype is at the FROM end
Renderer --[width @accesses]--> Config  the reader is at the FROM end, and the
                                        member is on the label
```

`@holds`, `@builds`, `@calls`, `@accesses` and `@conforms` put the subject first. `@takes` and `@returns` put the
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
| `@accesses` | yes | **no** | yes | yes | a text scan of the same member lists |
| `@conforms` | yes | **no** | **no** | yes | a text scan of the same declaration headers |

`@feeds` is not on it. It never accuses, so there is nothing to license.

**Every no is a finding rather than a design**, and none of them was visible
until the squares had to be filled in one at a time.

**Except one.** `@conforms` in Rust is the first square here that is a *design*,
and the only one a measurement cannot change. It is also **measured**, which no
other `no` here is: 4,975 asks over the five pinned Rust clones, 92.9% recall, 0
accused, 0 invented, and 0 confirmations when the same pairs are asked
backwards. On any other row those numbers would be a licence.

They are not one here because a Rust type does not carry what it implements.
Three separate places do — `impl Trait for Type` anywhere in the crate,
`#[derive(..)]` on the declaration, and a `macro_rules!` body, which is an
unparsed token tree and is where anyhow keeps some of its own. Refuting needs
all three to be complete and the third cannot be read at all, so an absence is a
statement about where somebody looked. A crate-wide index of `impl` items would
not fix that; it would produce a confident wrong answer about every derived and
every macro-generated conformance, which is a false red in the language this
project understands worst.

`measure:conforms` asks `@conforms` about JavaScript **0 times over 21 files**,
which is the third square JavaScript has failed to earn for the same reason: 21
files, and not one of them writes a class heritage clause. Python and TypeScript
are measured at **0 accusations and 0 inventions across 2,652 asks**, and asked
the same pairs backwards they confirmed **0** — which is the number the word
exists for, because before it an arrow drawn from the base down to the subclass
passed every check this tool had.

`measure:accesses` asks `@accesses` about JavaScript **0 times over 21 files**,
for the reason `@holds` is a no there: a JavaScript class writes no member list
a text scan can read off, so there is nothing to measure and so no permission.
The other four squares are measured at **0 accusations across 5,833 asks**.

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

`relations` is an exhaustive `Record`, so adding a ninth word to
`ARROW_CLAIMS` stops the build in every licence and in the test that pins the
grid, until somebody writes down what measured it. `@conforms` is the second
word to arrive with the grid in place and it stopped the build in three
licences, one test and the census's coverage table. `@accesses` is the first word
to arrive with the grid already in place, and it stopped the build in four
places on the line that added it to `ARROW_CLAIMS` — which is what the grid is
for. The answer is allowed to be
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
| `npm run measure:accesses` | can the member reader be trusted with a red |
| `npm run measure:conforms` | can the base-list reader be trusted with a red, and what confirm-only Rust costs — `--all` prints every disagreement |
| `npm run measure:holds` | can the field reader be trusted with a red |
| `npm run measure:calls` | can the call reader be trusted to say backwards, and how often it can answer |
| `npm run measure:constructs` | can the construction reader be trusted to say backwards |
| `npm run measure:signature` | the same for parameters and return types |
| `npm run measure:dataflow` | what following a value through one body buys, confirming and refuting |
| `npm run measure:licence` | reproduces the per-language dependency numbers, then prints the whole (word, language) grid — `--only=python` for one |
| `npx tsx scripts/probe-generative.mts` | draws boards of unseen code and counts what could not be said |

The pattern in all of them is a **referee**: count the shape one way, count it
again by a completely different mechanism, report the disagreement. It is not
ceremony. Between them these scripts have found eleven reader bugs and nineteen
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
  arrows carrying a claim    96%     (was 43% before @holds and @builds)
  arrows with no word at all   0     (was 26)
```

The last two were the TanStack board's inheritance arrows, and giving them the
word turned up something worth keeping: both were drawn **base-first** —
`Subscribable -> QueryCache`, labelled `extends` — and the code says `class
QueryCache extends Subscribable<QueryCacheListener>`. Wordless, an arrow can be
drawn either way round and nothing notices. With the word on it and the
direction left alone it goes red, which is the whole argument for having it.

Coverage of what the code says, from `measure:vocabulary`: **85.8%** against
everything the syntax shows, **89.3%** against relationships whose both ends are
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
| with `@calls` | 57.8% | 56.1% |
| with `@accesses` | 84.7% | 87.9% |
| with `@conforms` | **85.8%** | **89.3%** |

`invokes` was 61,499 of the 273,694 relationships the census reads, so it is the
largest single thing any one word here has ever covered. It is also the fourth
time a hand-maintained list in this programme went stale silently, which is why
the probe's own two lists were replaced with a shape rule in the same change.

`accesses` was the largest of the three by a factor of twenty-seven — 53,362
drawable against 1,946 for the next one — and #213 gave it `@accesses`.

`conforms` was the last one left and #216 gave it `@conforms`, at 2,352
drawable. It is the one word here that frequency did not argue for — two orders
of magnitude below `accesses` — and #187 had already settled that frequency
cannot decide inclusion, since `type-argument` is 12.6% of all code and is
deliberately out. What argued for it is the footing and the failure: it is read
from a declaration, and the arrow drawn from the base down to the subclass used
to pass every check this tool had.

**Nothing the census counts is wordless now** except `type-argument`, which is
deliberate: almost all of it is `Vec<T>`, `Promise<T>`, `list[str]`, which
nobody draws as two boxes.

## Thirteen times a measurement contradicted the design

Kept because the pattern is the point: eleven of the thirteen came from building
one word or one reader, not from reviewing the design.

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
10. **The referee was wrong 320 times out of 321.** `measure:accesses`'s first
   run reported 321 places where the reader refused a member a person could read
   off the declaration, which is 321 false reds waiting to happen. One was the
   reader: TypeScript writes a private member `#pending` and the grammar hands
   the name back with the hash on it, so 22 of the 321 were arrows about a
   private field. Every other shape was the referee — a `#` stripped as a
   comment in a language where it is a field sigil, so `async #flush() {` lost
   its brace and a whole method body read as a member list; a Python class body
   with no indent rule, so every local variable in every method read as an
   attribute; a docstring read as a declaration; a one-line `interface Row { .. }`
   that never closed; and a `class` nested inside a test method that column
   zero could not end.

   The number is the finding. A referee is a program somebody wrote, which
   #198 already recorded — what this adds is the ratio, and that the ratio was
   only visible because the accusation column is separate from everything else
   in the report. A single recall figure would have read 93% and hidden all of
   it.

   The other half is the shape a referee **cannot** find, and it is the reason
   this word did not ship on the strength of a zero. `constructor(private width:
   number)` declares a member in TypeScript's parameter list, and both the text
   scan and the tree walk read a parameter list as a parameter list — they
   agree, the measurement reports no disagreement, and the reader goes on
   refuting a correct arrow. It was found by reading the language rather than a
   number, and it is the one class of hole a shared-blindness referee will never
   report.

10. **A base is not its type arguments, and three programs disagreed about
    that.** `measure:conforms`'s first two runs, in order, and the order is the
    lesson.

    Run one: TypeScript read **13** pairs where the census reads 296 and tsx read
    **0** where it reads 313. The referee's `extends` pattern was
    `[^]]*?` — and in JavaScript `[^]` means *any character*, so `[^]]` is any
    character followed by a literal `]` and the pattern could never match a
    heritage clause at all. A regex that matches nothing reports perfect recall
    over the handful of pairs it does find, which is why the run prints its
    sample size next to a number the census can be compared to.

    Run two, with the pattern fixed: one refusal in 214, on `class ListboxStore
    extends ReactStore<\n ListboxState,\n ListboxContext,\n typeof selectors\n>`.
    Two bugs met there. TypeScript hangs a class's type arguments off the clause
    as a **sibling** of the base name rather than wrapping the two together the
    way it does in an interface's heritage — so the reader, which refuses by
    default, read the argument list as an expression it could not parse and put a
    permanent doubt on the declaration. A doubt silences *absences*, so
    `@conforms` would have shipped unable to refute any arrow on any class with
    a generic base, and it would have looked fine from the confirming side.
    Meanwhile the referee had followed the header only three lines, held an
    unbalanced `<`, and split the type arguments into three separate bases.

    Fixing the reader made **three new accusations appear**, which is item 6
    again: `class MoodMiddleware(AgentMiddleware[AgentState, ContextT,
    ResponseT])` splits into four things at the commas and three of them are
    arguments of the first. The reader had just been taught not to read through
    them and was right; the referee was reading a type argument as a base, one
    language over from where it had just been fixed.

    The design question underneath was settled by having to fix it: reading
    through a generic is right for `@holds`, where `Vec<RouteInfo>` really does
    hold a RouteInfo, and wrong here, where `Store` is one of `Cache` and not of
    `Entry`. Two words, the same syntax, opposite answers — and the census still
    counts it the loose way, which is why its 2,919 is a little generous.

11. **Rust does not write conformance where the design assumed it did.**
    `@conforms` shipped reading `impl Trait for Type`, on the reasoning that
    this is how Rust says a type implements a trait. It is how Rust says it when
    a human writes it out. Most of the time nobody does.

    The default corpus holds 22 Rust files, so the Rust row was re-run over the
    five clones the dependency licence already pins — 775 files — the way #189
    widened its own Rust row. **1,401 written trait impls. 3,741 conformances
    from `#[derive(..)]`.** Two and a half times as many, and the reader could
    see none of them: `#[derive(Clone, Debug)]` generates the impls at compile
    time, so there is no `impl Clone for Config` anywhere in the source to find.
    A board saying `Config --@conforms--> Serialize` about a derived Serialize
    got silence, with the answer written on the line above the declaration.

    Reading the derive list took Rust from 86.8% to **92.9%** recall, all of it
    confirmations. Nothing about the accusation changed, and the finding is why:
    a derive list is *on* the declaration and looks closed, and it is not,
    because the same trait can be implemented by hand in any file in the crate.
    Three sources, one of them a `macro_rules!` token tree nobody can parse, and
    refuting needs all three.

    So the measurement did two opposite things at once, which is the part worth
    keeping. It made the word much better in Rust — the larger half of the
    relation went from unconfirmable to confirmed — and it made the argument
    against ever letting Rust accuse **stronger** rather than weaker. A crate-wide
    index of `impl` items, the obvious next build, would have refuted 3,741 true
    arrows.
11. **#227 — a receiver's type resolves from the text alone 9.5% of the time,
    and reading the text is not the wall.** #221's `receiver` blocker (item 10
    above) asks whether `x.foo()` can be placed; #227 asks the question one
    step upstream, before #226's proposal to build a real type-checker
    integration (tier 2): given only syntax, what can `x` be worked out to be?

    `measure:resolution` walked seven trees, five languages, 65,452 receiver
    call sites. **6,206 resolve** — 9.5% overall, and unevenly: rust 14.2%,
    ts 13.4%, python 11.0%, js 11.4%, tsx 1.3%. The gap between ts and tsx is
    the same gap #217 found in `@calls`: tsx's population skews toward JSX
    props threaded through many components, which import types rather than
    declare them locally, and `imported-type` is tsx's largest single refusal
    at 44.2%.

    The number that matters more than the headline: **`not-a-name` is the
    largest refusal in every language but rust**, 32–52% of everything
    withheld. Most receivers in real code are not a bound name to begin with —
    `row["bucket"].isoformat()`, `datetime.now().isoformat()`, `gpu_type.lower()
    == gpu_type.lower()`. No amount of reading declarations closes that gap; it
    is a different question, chaining and indexing rather than binding, and
    #227 keeps it explicitly out of scope. So the ceiling on a syntax-only
    resolver is nowhere near 100% even in principle, which is the strongest
    argument in #226's file for tier 2 being closer to a hard requirement than
    an upgrade.

    **The referee, run for real against the resolved sites** — `tsc` for
    ts/tsx/js, pyright via `reveal_type` for python, both through the same
    corpus: 1.1–2.0% wrong on TypeScript, 1.4% on Python, after six rounds of
    reading every disagreement and fixing what was actually a reader bug
    rather than a narrowing artifact. Four of those six were the same shape
    #169 and #217 both name in this file already: a shape nobody had written a
    fixture for yet. `Foo[]` read as `Foo`; `readonly Foo[]` read as `Array`
    instead of `ReadonlyArray`; a nested tuple type read three levels down to
    its innermost element; an inline object type read as its first field's
    type; a Python `module.Class` annotation read as `module`; and a plain
    method call on a variable named `list` or `dict` read as constructing a
    fresh one, because `collectionHeadOf` split a callee's text on `.` the same
    way `dataflow.ts`'s own `makesCollection` does, which is right for Rust's
    `::` and wrong for everyone else's receiver dot.

    What is left after those fixes is almost entirely one shape, not a list of
    unrelated misses: the annotation says what a value was **declared** to be,
    and the referee's `reveal_type` at the exact use point says what it has
    **narrowed to** — `dict` annotated, `defaultdict` constructed and never
    reassigned before use; `object` or `Any` annotated, `isinstance(x, dict)`
    checked first; `unknown` annotated, `typeof x === "string"` checked first.
    Both answers are true, about different questions, and closing that gap
    is control-flow analysis — the same wall item 7's dataflow work already
    stopped short of for a related reason. It is recorded here rather than
    chased, on the same grounds #227 keeps a call graph out of scope: the
    question changes shape as soon as flow enters it.

    Recommendation to #226, with the number behind it: **tier 2 is closer to a
    hard requirement than a nice-to-have.** Reading the text alone gets under
    10% of receivers, and the reason is structural — most receivers are not a
    name — not a reader gap that more shapes would close. Where this reader
    does answer, it is now measured trustworthy (under 2% wrong, against a
    real checker, in every language that has one), so it is sound evidence to
    build a tier-1 fallback on when a project's build is broken and tier 2 goes
    silent. It is not a substitute for tier 2 as the primary source.

    **#217/#221, re-read against this number: reaffirmed, on the same footing
    #221 measured, with the follow-up it did not have the tool to ask.** #221
    recommended against a closed-call-set `@calls` on a per-*body* ceiling of
    15.1%, receiver calls the sole blocker in 28.8% of what stayed open. #227
    measures the step underneath that — per *receiver*, not per body — at 9.5%,
    for a structural reason (`not-a-name`, 32–52% of refusals) that reading more
    declarations cannot close. Two independent measurements of adjacent
    questions land on the same wall, which is corroboration, not restatement.

    What neither measurement asked, because tier 2 did not exist to ask it:
    whether a real checker closes the 28.8% that syntax cannot. `tsc`/pyright
    plainly resolve past what `resolution.ts` does — that is the entire
    referee this issue's own measurement leans on — but resolving a receiver in
    isolation and closing a *body's whole call set* are different questions,
    and #221's per-body number was never re-run against a compiler-backed
    receiver. So: the recommendation stands, and it stands on syntax's ceiling
    specifically, not on the idea generally. The number that would move it is
    `measure:closed-bodies` re-run with tier 2 wired into the receiver
    position, once tier 2 exists — not before, and not assumed in its favor
    now. Leaving that unmeasured and treating today's "don't build it" as final
    would be the same mistake item 9's zero warns against: reading an absence
    of evidence as evidence of absence.

    **Run: see item 13.** Tier 2 exists now, the re-measurement is done, and
    the recommendation held — for a different, structural reason than the one
    that opened this question.

12. **Tier 2's actual ceiling, measured: 97.8% (ts/tsx/js), and two harness bugs
    stood between that number and a wrong one.** Item 11 argued tier 2 was
    necessary from what tier 1 could not reach; nobody had asked a real
    compiler the same question with no gate at all. `measure:resolution`'s
    new section 6 does — every receiver, `not-a-name` included, `tsc` asked
    directly.

    The first honest-looking answer was **35.7%**, and it was wrong, in the
    AGENTS.md sense of a number nobody checked before quoting. Two causes,
    found by asking why rather than reporting the figure:

    - `mundane` and `infrarouter`, two of the seven corpus trees, had never had
      `npm install`/`bun install` run in them. No `node_modules` means the
      compiler has no idea what an imported package exports, so it falls back
      to `any` for anything that touches one — collapsing `tsx` (React props,
      almost entirely imported types) to 11.4% and plain `js` to 0.2%. A low
      number here did not mean the compiler could not help; it meant the
      compiler was never given the chance to. Installing dependencies in both
      trees was the fix, not a reader change.
    - `createTsReferee` built **one `ts.Program` from the tree's own root**,
      using `ts.findConfigFile`, which searches upward from wherever it
      starts and never down into a subdirectory. A monorepo's real config
      lives in each package — `mundane` alone has 22 `tsconfig.json` files,
      none of them at its root — so every file in one built with generic
      defaults, no `paths`, no aliases, silently. `scripts/lib/licence.ts`
      had already solved this for a different question (module-resolution
      options, not a type checker); the same nearest-config-per-file walk,
      ported here, is the fix. Verified against the compiler directly on the
      old code before touching it: an aliased import (`@lib/thing` via a
      package-local `paths` entry) resolved to `any` before the fix and to
      the real constructed type after it, on the same fixture — now
      `tests/resolution-referee.test.ts`, two shapes: one package's alias
      reachable from below the tree root, and two sibling packages kept
      apart rather than one answering for the other.

    A third bug surfaced fixing the other two: giving `mundane` real
    dependencies grew it to 126,371 files, and `measure-resolution.mts`'s own
    file walker piped `find` through `execFileSync`, which throws `ENOBUFS`
    past a certain output size — caught by a blanket `catch { return []; }}`
    that read the crash as "no files here." The whole tree silently dropped
    out of the corpus with no error printed; the fix was the same
    prune-while-walking `readdirSync` recursion `resolution-ts.ts` and
    `licence.ts` already use, which never lists `node_modules` in the first
    place rather than listing and filtering it.

    With both fixed: **97.8%** of ts/tsx/js receivers resolve against the real
    compiler with no reader gate — ts 98.4%, tsx 99.9%, combined with tier 1
    98.1%. `js` stays low, 16.7%, and is not chased here: `checkJs` is off (the
    same setting `dataflow.ts` and `resolution.ts` both hold to for untyped
    JS), the population is small — 420 of 31,853 receivers — and the honest
    open question is whether `checkJs: true` helps or just adds noise, not
    answered by this measurement.

    This is not "tier 2 is closer to a hard requirement" any more; it is a
    number. Reading text alone reaches 8.1% of what a real compiler reaches on
    the same population, once the compiler is actually given a fair run.
    `npm run measure:resolution` now needs `NODE_OPTIONS=--max-old-space-size=
    8192` (wired into the npm script) — one real `ts.Program` per package,
    built one or two at a time rather than all at once, still peaks well past
    Node's 2 GiB default on a package the size of one of `mundane`'s apps.

13. **#221, re-measured with tier 2 actually wired in: reaffirmed, and now for
    a different reason than the one that opened the question.** Item 12's
    reaffirm note named the exact test this required: re-run
    `measure:closed-bodies` with a real checker as the receiver resolver,
    since `receiver` was 28.8% of what kept a body open and tier 2 resolves
    97.8% of receivers. That test is now run.

    `calls.ts` gained one optional field on `CallSide` — `resolveReceiver` —
    consulted at `placeOf`'s three `receiver` dead ends and nowhere else;
    `resolves`/`callsTo`, the live path `drift.ts` uses, never sees it. A type
    a resolver names is placed exactly the way a bare name already is:
    declared here, imported and traced, or neither. No new refusal reason —
    a resolver only narrows `receiver` into a word this reader already had.

    The closed share moved **10.5% → 12.6%** (ts/tsx/js, 2,541 bodies with
    calls) — real, and nowhere near what the receiver numbers alone predicted.
    `receiver` as the *sole* blocker fell from 1,255 open bodies to 46 — the
    resolver works, exactly as measured in item 12 — and only 51 bodies
    actually closed. The other ~1,200 did not vanish; they moved almost
    entirely into `unbound`, which rose to 1,355 sole-blocker bodies, 61.0% of
    what stayed open.

    The mechanism, checked rather than assumed: `placeName` can place a
    resolved type only when *this file's own text* imports or declares it.
    Most receivers resolve to `Array`, `Promise`, `string`, a class from a
    package never named as a dependency of the call being asked about — real,
    correct answers that no file's import list was ever going to contain,
    because nothing imports a language builtin. `receiver` was never the wall
    on its own. It was standing in front of `unbound`, and resolving the
    first exposes the second rather than removing it — the same shape item 9
    found for `@calls` itself, one layer up: an abstraction that looks like
    the blocker turns out to be hiding the real one underneath.

    So tier 2 does what it was measured to do — it answers `x`'s type nearly
    every time — and the closed-body question was never really asking that.
    It needs the type *placed to a file*, and a builtin or an untracked
    package dependency has no file this reader's population will ever supply
    one for. #221's "don't build it" stands, now on a structural reason a
    better resolver cannot reach, rather than on tier 1's reach being too
    small to try. `docs/claim-vocabulary.md`'s own #226 record can stop
    flagging this as open: the number that was going to decide it has been
    run, and it decided against.

`renders` was also raised as a possible missing relation and turned out not to
be one: `<MenuContent />` is a routine making a MenuContent, which is `@builds`.

## Open, in the order worth doing

1. ~~**The licence grid.**~~ Built at #207 and shipped at #209. `@accesses` is
   the first word to arrive with it already in place, and adding the word to
   `ARROW_CLAIMS` stopped the build in four places until every licence had an
   answer for it — which is exactly what it was built to do. One `Licence` entry
   now speaks for **eight** words on the strength of five separate
   measurements, and the type says which.
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

**#216 — `@conforms`** is done, and it is the word that made the grid's second
axis do something no other word needed: `mayAccuse("conforms", "rust")` is a
stated **no** on a language whose reader works, because the fact is in another
file. Python and TypeScript were measured at 0 accusations and 0 inventions over
2,652 asks, and 0 confirmations when the same pairs were asked backwards.

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
- **Structural conformance**, and it is the same shape as the item below. A
  TypeScript object that satisfies an interface without naming it, or a Python
  class that satisfies a `Protocol` the same way, is written down nowhere — so
  `@conforms` refuses an arrow at a routine rather than answering it. What
  would be needed is a type checker, which is `#203`'s wall.
- **Transitive conformance.** `A extends B extends C` confirms `A -> B` and says
  nothing about `A -> C`. Resolving every base in a tree is a cross-file walk
  with its own measurement, and nobody has asked for it.
- **A crate-wide Rust reader**, which is the obvious thing that would let
  `@conforms` accuse in Rust: every `impl` in the crate, indexed, so the region
  is the crate rather than the file. It was measured before being declined, over
  775 Rust files rather than the 22 in the default corpus, and the number is why
  it is not being built. **1,401 written trait impls against 3,741 conformances
  from `#[derive(..)]`** — so an index of `impl` items would hold the smaller
  half of the relation and refute the larger one, and `anyhow` writes some of its
  own inside a `macro_rules!` body, which is an unparsed token tree. A reader
  that must union three sources and can only read two cannot close a region, and
  a confident wrong answer in Rust is the false red this project can least
  afford.
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
