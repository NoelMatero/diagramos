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
| `@accesses` | accesses | a type's member list — **and** a routine's body | yes | **absence**, at both ends — the routine end by name |
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
- The **routine** end is a body. Working out what a body touches *off Config*
  needs every receiver's type, which needs the whole program — the may-analysis
  #203 measured and rejected. So until #255 this end confirmed and was otherwise
  silent.

  #255 found the half of that which is not true. A read of `Config.width` is
  written `something.width` whatever `something` turns out to be, so a body
  whose every read has a `.name` — no destructuring, spread, `c[k]`, `getattr`
  or macro — and none of whose reads is called `width` does not read `width`
  off anything. The type is only needed to refute in a body that *does* contain
  `.width` off something else, and that is exactly where the typed design made
  its false reds. So the routine end now refutes **by name**, and stays silent
  wherever the body reads a member without a name, reads none at all, or calls
  a function that visibly reads the member ([item 25](#twenty-five-times-a-measurement-contradicted-the-design)).

So the two ends refute on two different footings: the type end from a
declaration, the routine end from a body read whole by name. Neither accuses
from a doubt about the other.

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

`@accesses` is the second word with an **absence** square beside `@calls`, and
its are the routine end refuted by name (#255). All five languages are licensed:
**about 2.5 million asks** over the twelve pinned clones, **14 disputed**, every
one a Python parameter annotation the referee read as a member read. That
includes JavaScript, whose presence square below is a *no* — refuting at the
routine end reads a body, and a JavaScript body reads the same as a TypeScript
one, while the presence square needs a member list JavaScript does not write.
The table above is the presence axis; `licence.ts` carries both.

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

**That last sentence was half right, and #254 is the half it got wrong.** The
refusals were correct. The 622 confirmations were never checked by anything, and
six of them were calls to a standard-library method — a green nothing earned,
and in the reverse direction a red. A referee's blind spot is a fine reason to
report a population apart; it is not a reason to leave the reader's answers on
it unread. `measure:calls` now asks a real checker "go to definition" at the
call's own name, which is exactly the question the text scan cannot put, and the
receiver calls are scored rather than set aside. See item 24.

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
| `npm run measure:calls` | can the call reader be trusted to say backwards, and how often it can answer — a real checker places the receiver calls its text scan cannot (#254); `--no-checker` for the text scan alone, `--control` to ask the checker the questions the scan already answers, `--dump=<file>` for every answer including the agreements |
| `npm run measure:constructs` | can the construction reader be trusted to say backwards |
| `npm run measure:signature` | the same for parameters and return types |
| `npm run measure:dataflow` | what following a value through one body buys, confirming and refuting |
| `npm run measure:licence` | reproduces the per-language dependency numbers, then prints the whole (word, language) grid — `--only=python` for one |
| `npx tsx scripts/probe-generative.mts` | draws boards of unseen code and counts what could not be said |

The pattern in all of them is a **referee**: count the shape one way, count it
again by a completely different mechanism, report the disagreement. It is not
ceremony. Between them these scripts have found twelve reader bugs and nineteen
referee bugs, and not one was reachable by thinking about it.

**A referee has a blind spot of its own, and `measure:calls` now has a second
referee for exactly that** (#254, item 24). Where a text scan cannot say whose
`foo` is meant in `x.foo()`, a real checker can be asked "go to definition" at
`foo` — and where the two referees can both answer, they agree.

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

## Twenty-five times a measurement contradicted the design

Kept because the pattern is the point: eleven of the first thirteen came from
building one word or one reader, not from reviewing the design. Nothing since
has broken that — item 24 is the clearest case of it, a reader bug four
measurements had walked past because the population it lived in was reported
apart and never scored. Item 25 is the other kind: an issue's premise, that a
word needed a type checker, which measuring both designs over the same bodies
turned out to be wrong about.

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

13. **#221, re-measured with tier 2 actually wired in: reversed. 10.6% →
    50.3%, and the first two readings on the way there were both wrong in a
    checkable way, which is the reason this entry is longer than a number.**
    Item 12's reaffirm note named the exact test this required: re-run
    `measure:closed-bodies` with a real checker as the receiver resolver,
    since `receiver` was 28.8% of what kept a body open and tier 2 resolves
    97.8% of receivers. Three readings, each one found by checking the
    previous one rather than trusting it:

    **Reading one, 12.6%.** `calls.ts` gained `CallSide.resolveReceiver`,
    consulted at `placeOf`'s `receiver` dead ends; a resolved type was placed
    exactly as a bare name would be — declared here, imported and traced, or
    `unbound`. `receiver` as sole blocker fell from 1,255 bodies to 46, and
    only 51 bodies actually closed. Read as "the closed-body question was
    never really asking what tier 2 answers" — a type needs to be placed
    *to a file*, and a name search over one file's own text was never going
    to place `Array`, `Promise`, or a package never imported by that literal
    name at that call.

    **Reading two, 43.4% → 44.7%.** That framing conflated two different
    dead ends under one word. `getSymbol()` on a resolved type gives the
    compiler's own answer to *where it is declared* — a question a name
    search never asked. `ReceiverResolution` gained `{ kind: "external" }`
    (declared outside the tree — closes the call on the spot, no name match:
    a call that provably lands outside the repository provably is not any
    repo routine) and `{ kind: "declared"; file }` (declared *inside* the
    tree, at a file the compiler names directly — closes what a name search
    structurally cannot: `const x = make(); x.run()` binds no name to `x`'s
    real type anywhere in the file's own text, only to `make`, the function
    that produced it).

    **Reading three, 50.3%, and checked closed.** A per-*query* tally
    (`resolverAnswers`) counted what the resolver actually answered —
    `declared`/`external`/`type`(no file)/`none` — against a matching
    per-*site* reason count, restricted to receiver sites only
    (`CallSitePlaced.receiver`, added because comparing a query count against
    a body count, and later against a site count that silently included bare
    unimported calls, produced two more wrong-looking gaps before this one
    held up). That check found a real bug: `placeOf` only asked the resolver
    at two of the four points a `through` callee could dead-end at. Whenever
    the receiver's own bare name happened to *also* match something in
    `bindings.imported` — ambiguous, an unresolved specifier, a re-export
    chain that ran out of road — the reader tried to place the name as a
    *namespace* first and, on failure, gave up without ever asking what the
    receiver's *value* actually was. Fixed at all three points; confirmed by
    the same tally afterward: **1,646 remaining receiver sites, at or under
    the 2,076-site structural ceiling** (`type`-with-no-declaring-file plus
    no answer at all) — the check that closes the loop, not a second guess.

    Two things stayed genuinely unreachable, both structural rather than a
    reader gap: a union or bare primitive has no single declaration for
    `getSymbol()` to return (`string`, `Node | null`), and `js` resolves
    nothing new at all (`checkJs` is off, unchanged from item 12).

    #221's "don't build it" is **reversed**: half of ts/tsx/js bodies that
    call anything now have a call set this reader can enumerate completely,
    against 10.6% reading text alone. Whether that is worth turning into an
    actual `@calls`-refutes-absence word is a separate decision — it still
    needs the licence grid (#209), a per-language measurement of how often
    *this* reader is wrong, and #217's other two shapes (altitude, label
    contradiction) are untouched by any of this — but the ceiling itself is
    no longer "real and nearly empty."

    **ts/tsx/js only, and item 23 is where the other two languages were asked.**
    The reversal is TypeScript's: Python closes a quarter and Rust a sixth.

14. **Item 13's reversal, checked against AGENTS.md's own gate: 0.7% wrong,
    and two of the bugs that measurement found were in this session's own
    code, not in a hazard nobody anticipated.** "50.3% closed" says how much
    of ts/tsx/js the mechanism reads. Nothing yet said how often it is
    right, and AGENTS.md's rule is exact: nothing new may say *wrong* until
    that number exists, from a referee sharing no machinery with the reader.
    (One of the two fixes below moved the closed share itself, slightly:
    **49.6%**, 10.3% at tier 1, after both are applied — a more honest
    number than item 13's, not a different one; the shape of the finding is
    unchanged.)

    The check: `calls.ts` gained a second field per receiver site,
    `memberAt` -- the method's own byte range (`foo` in `x.foo()`), not the
    receiver's (`x`). For every call `declared`/`external`/`type` actually
    placed, `symbolDeclarationAt` asks the same compiler a more direct
    question -- `getSymbolAtLocation` on the method itself, the call a real
    "go to definition" makes -- and the two answers are compared.

    First run: **2.5% wrong** (227 of 9,092), almost all one shape:
    `PUNCTUATION.has(entry.type)` -- `PUNCTUATION`, a `Set` genuinely
    *imported by name* into the file -- placed at `PUNCTUATION`'s own file,
    `engine/rust.ts`. The mechanism: `bindings.imported` already marks an
    import `namespace: true`/`false` (`import * as x` against `import { x
    }`), and `placeOf`'s pre-existing name-search branch never checked it --
    any receiver whose bare name happened to be imported at all was tried as
    a *namespace* first (`ns.foo()`: is `foo` declared in `ns`'s file?),
    permissively answering "probably" when the target file had no wildcard
    export to rule it out. Right for a real namespace import; never
    consulted a resolver at all for an ordinary named one used as a value.
    Fixed by skipping straight to the resolver whenever `through` names a
    plain (non-namespace) import — a bug in the reader `calls.ts` already
    had, exposed rather than created by giving receivers a resolver to fall
    back to.

    Second run: **0.8%** (75 of 9,092). Remaining shape:
    `row.bucket.padEnd(10)` -- `row.bucket`'s type is a string-literal union
    (`type Bucket = "a" | "b" | ...`) declared in one file; `typeAt`'s
    `declaringFile` fell back to `type.aliasSymbol` when `getSymbol()` found
    nothing, which for a union answers with the *alias's own* declaration
    site -- true about where `Bucket` is written, false about where a value
    of that type lives once its calls resolve straight through to
    `String.prototype`. Fixed by dropping the `aliasSymbol` fallback for
    `declaringFile` entirely -- a type alias's declaration is not evidence
    about what a value of that type's *methods* resolve to, only about
    where the alias itself happens to be spelled.

    Third run, after both fixes: **0.7%** (62 of 8,964) -- ts alone at
    **0.1%** (8 of 7,423), tsx at 3.5% (54 of 1,541), concentrated almost
    entirely in one third-party menu component library's own internal
    generic store pattern in one test tree (`mundane`'s `ListboxStore`), not
    spread across the corpus. For comparison, the number this repo already
    shipped a word on: item 12's tier-1 resolver measured 1.1–2.0% wrong on
    TypeScript before any of this. This mechanism is now measured *below*
    an already-accepted bar, not merely "seems fine."

    The honest limit stays honest rather than getting explained away: this
    referee asks the *same compiler* the reader does, at a *more specific*
    position, so it catches wrong plumbing and wrong node-finding, but a
    receiver whose declared type is an interface or a generic wrapper, where
    the concrete implementation is decided by something the type system
    itself cannot see, would agree with the reader's mistake rather than
    catch it. `mundane`'s remaining tsx cases are exactly this shape --
    `use-listbox-item.ts` reached through a type declared as
    `use-popup-menu-item.ts`'s own hook -- and no compiler-based referee
    closes that gap, because the reader and the referee share the one
    limitation neither can see past. Named rather than measured away: the
    number above is a floor on how wrong this is, not a ceiling on how
    right.

    Whether any of this becomes a real `@calls`-refutes-absence word was the
    open design question this entry left standing. Item 15 answers it.

15. **The licence grid got a second axis rather than a second gate, and
    `@calls` is the only word to use it (#231).** Items 12-14 measured two
    things -- 49.6% of ts/tsx/js bodies with a closed call set (10.3% at
    tier 1 alone, once both of item 14's bugs are accounted for), and that
    set wrong 0.7% of the time -- and neither one is a licence by itself. A
    licence is what `mayAccuse` checks, and `mayAccuse` answered only one
    question before this: has *this* word's reader earned the right to say
    *wrong*, in *this* language. Closed-body absence is not a refinement of
    that answer. `@calls` already had a way to say wrong -- finding a call
    running the other way (`calls.ts`'s `backwards` verdict) -- and this is
    a second, independent way the same word can be wrong, resting on a
    different reader and a different number.

    Two shapes were open, and the choice was made with a person rather than
    guessed at, because it changes what "exhaustive" means for every future
    word:

    - **Extend the grid.** Give every `(word, language)` answer a second
      dimension -- does it license an accusation resting on something
      *found* (`presence`), on something a reader *closed off*
      (`absence`), or both -- and keep the one guarantee #207 already
      bought: a licence with a hole in either dimension does not compile.
    - **A parallel gate.** A standalone `mayAccuseFromAbsence(language)`,
      checked only by the new code path. Smaller, but now two gates that
      nothing stops from drifting apart as words and languages are added --
      close to the exact bug #207 made impossible for the first gate,
      reopened for the second.

    The grid won. `AccusalLicence` replaces each word's single row with
    `{ presence, absence }`, both `RelationLicence`, both required --
    `NOT_DESIGNED_YET` is the honest `absence` answer for every word but
    `@calls`, and `NO_CLOSED_BODY_RESOLVER` is `@calls`' own answer outside
    ts/tsx, so a hole reads as a stated absence of a measurement rather
    than a missing field. `mayAccuse` gained a third, defaulted parameter
    (`axis: AccusalAxis = "presence"`) instead of a sibling function, so
    every one of the eleven existing call sites -- `calls.ts`, `holds.ts`,
    `accesses.ts`, `signature.ts`, `constructs.ts`, `conforms.ts`,
    `needs.ts`, and the five `measure-*.mts` scripts that print this grid --
    reaches the same row it always has, unchanged. `mayAccuse("calls", "ts",
    "absence")` and `("calls", "tsx", "absence")` are the two squares that
    say yes; everything else on this axis, everywhere, still says no.

    Wiring that licence into an actual board verdict -- `calls.ts` treating
    a closed body's `absent` as a `wrong` rather than silence -- is
    explicitly **not** this issue. #231 is the gate only, on purpose:
    nothing past it can be built on a permission that does not exist yet,
    and building the gate and the thing it gates in the same change is how
    the gate ends up untested against its own "no".

16. **The gate item 15 built now gates something real, and the interface
    guard it was required to carry has a measured cost: 11.7% of closed
    bodies (#233).** `callsBetween` gained a fourth verdict, `refuted`,
    returned in place of `absent` only when `mayAccuse("calls", from.language,
    "absence")` says yes and `callSitesIn` -- the same reader items 12-14
    measured, now given a live `resolveReceiver` backed by
    `scripts/lib/resolution-ts.ts`'s `createTsReferee` for the first time --
    finds `from`'s whole call set enumerable and none of it reaching `to`.
    `drift.ts` turns it into `calls-refuted`, a new accusing `EdgeFindingKind`
    beside `calls-backwards` rather than a replacement for it: the two rest
    on different readers (a call found running the other way, versus every
    alternative closed off) and neither implies the other.

    Verified against a real board rather than only against the reader in
    isolation: a scratch repo with two TypeScript functions that share
    nothing goes red on `npm run check:drift` with `calls-refuted`, quoting
    "every call `run` makes was checked -- 0 of them, none reaching
    `src/b.ts`." A third function reaching the same target only through a
    receiver typed as an interface stays silent, checked against the real
    compiler rather than a mock -- the one shape item 14 named as unsafe to
    accuse from, confirmed unsafe again end to end before this reached a
    live path.

    **The guard's cost, measured rather than assumed** (`npm run
    measure:closed-bodies`'s new section 7b): of the bodies tier 2 finds
    closed, **11.7% (148 of 1265)** carry at least one `declared` placement
    whose type is not concrete, and stay withheld rather than refuted --
    13.0% of closed TypeScript bodies, 4.0% of TSX, 0% of the five closed
    JavaScript bodies. Coverage spent on trust, which is the trade item 4 of
    #233 asked for and `licence.ts`'s own opening paragraph argues for
    generally: a false accusation is not recoverable by being right
    afterwards.

    **A finding this measurement re-run surfaced that is not about #233's
    code:** the overall closed-share this run reads -- 1488 of 11444 bodies,
    13.0% -- is far below item 12-14's recorded 49.6%. Read naively that
    looks like a regression. It is not one: re-running the identical
    measurement at the commit immediately before this issue's changes
    (#232's merge, before a single line of #233 landed) reads 1488 of 11440,
    the same 13.0%, on the same machine against the same `~/mundane` and
    `~/infrarouter` checkouts. `@calls`' closed-body reader did not change
    shape; the two corpora item 12 already named as unpinned, live, local
    directories did -- they are not the five commit-pinned repositories the
    `needs` licence corpus above is measured against, and nothing here
    reproduces them at the commit items 12-14 read. The 49.6%/97.8%/0.7%
    figures already formalized into `LICENCES` (#231/#232) are not
    corrected by this entry: they are what was measured on 2026-09-08 and
    remain the licence of record until somebody re-measures deliberately,
    the same way `needs`'s pinned corpora are the reason that licence *can*
    hold a real zero. This entry's own number -- the guard's 11.7% -- is a
    *share of whatever closes*, which is far steadier under that drift than
    an absolute count, and is why it is reported as one.

`renders` was also raised as a possible missing relation and turned out not to
be one: `<MenuContent />` is a routine making a MenuContent, which is `@builds`.

17. **Python's version of items 12-14, run for real: two readings, the first
    wrong in a checkable way -- 89.6%/2.8%, then 85.5%/1.76% once a real
    placement bug was found and fixed (#235, #236).** Items 11-14 built this
    whole ladder for TypeScript against `tsc`'s compiler API; #235 is the
    same ladder for pyright, and the premise it opens on -- that getting a
    *file*, not just a type's printed name, requires pyright's
    language-server mode (`pyright-langserver --stdio`, real
    `textDocument/definition` requests) rather than the `reveal_type`
    diagnostics trick `resolution-python.ts` already used for #227 -- was
    checked against a running server before any client code was written, per
    `AGENTS.md`'s "reproduce before reasoning" rule. Two things the issue's
    own framing did not get quite right, both found that way:

    - **`textDocument/definition` alone is the wrong tool for half the
      question.** Asked at a receiver's own position (`c` in `c.load()`), it
      follows `c` to *its own assignment* -- correct LSP behaviour, wrong
      question. Getting where `c`'s *type* is declared -- TypeScript's
      `typeAt().declaringFile`, the thing item 12's 97.8% is actually about --
      needs `textDocument/typeDefinition`, a capability pyright also
      advertises (`typeDefinitionProvider` in its own `initialize` response)
      that the issue never named. `symbolDeclarationAt`'s counterpart --
      where the method actually *called* is declared -- is answered by
      `textDocument/definition` after all, asked at the method's own
      position rather than the receiver's. `scripts/lib/resolution-python-lsp.ts`
      wires both, one LSP method per question, and
      `tests/resolution-python-lsp.test.ts` pins the distinction down with a
      server rather than a comment: asking `definition` at the receiver's own
      position on purpose, in one test, to show it lands somewhere else
      entirely.
    - **No `didOpen` is needed, and no readiness notification exists to wait
      on because of it.** Confirmed live: pyright answers both LSP methods
      against on-disk files it was never told to open, because it indexes a
      workspace from `rootUri` on its own. The cost of skipping `didOpen`:
      pyright never emits `pyright/beginProgress`/`endProgress` for a
      document it does not know is open, so there is no signal for "the tree
      is indexed" to wait on. The first cut of the client retried every
      `null` answer with the same long backoff, on the theory that `null`
      always meant "not warmed up yet" -- true for the first few queries,
      false for the rest of a real corpus. On `graphify` (22,449 receiver
      sites) that read as throughput collapsing from ~14/s to ~3/s as the run
      went on: an increasing share of what remained was a position pyright
      genuinely has no answer for, each one paying the full ~15.75s ladder
      meant for "not ready yet." One explicit `warmUp` call per tree, before
      the real batch, followed by a short retry for everything after,
      brought the same run down to under nine minutes -- the fix `#234`
      already made for a different reason (pay the expensive part once, not
      per query) applied to a different bottleneck.

    **Section 8's number, no reader gate, `not-a-name` included, the same
    shape item 12 measured for TypeScript:** two real Python corpora,
    `graphify` (22,449 receiver sites) and `infrarouter` (1,172) --
    `~/mundane`'s own share of this corpus was left out of this run, not
    measured at zero: its `tsconfig.json`-per-package TypeScript analysis
    (items 12-14's own long pole, the reason `measure:resolution` needs an
    8 GiB heap at all) took over 30 minutes with no Python query yet issued,
    for a monorepo reason `#235`'s LSP client does not touch.

    **Reading one, 89.6%/2.8%, and read closely rather than just counted --
    which is what caught it.** `#236` was opened to decide whether that
    wrongness number cleared the bar TypeScript's own version cleared
    (0.7%/1.1-2.0%), read it as clearly not clearing it, and closed itself
    with that written down. What kept this from being the end of the story:
    a handful of the printed disagreements had a shape the "declared type
    wider than the narrowed value" explanation did not actually fit --
    `self._market("inference").expect(...).build()` disagreed on *both*
    `.expect(...)` and `.build(...)`, and the file `typeDeclarationAt` named
    for both was the *test file doing the chaining*, not anything from the
    harness the chain is actually built from. A wrong answer with a
    plausible-sounding name is exactly the failure `docs/reading-a-grammar.md`
    warns never announces itself -- it takes reading the disagreement, not
    just its count, to notice a receiver's own declared type should never be
    the file of the *test currently running*.

    **The bug, found the same way item 14's two TypeScript bugs were --
    reproducing one specific disagreement rather than reasoning about the
    check in general:** LSP has no "ask about this exact node" request the
    way `resolution-ts.ts`'s `checker.getTypeAtLocation(node)` does --
    `typeDeclarationAt` had to pick *one position* inside a receiver's
    `[start, end)` range and ask there, and it picked `start`. For a plain
    name that is the only token in the range, so it was never wrong there.
    For a **field** (`self.cache` -- `self`, not `cache`) or a **chain**
    (`self._make().step()` -- `self`, not what `.step()` returns) it is the
    *first* token of a multi-token expression, and asking there answers what
    `self` is -- the enclosing class, declared wherever the calling method
    happens to live -- not what the receiver expression actually evaluates
    to. `self`'s own declaring file is very often the *same file the call
    site is in*, which is exactly the shape that read as "declared type
    names a repo file" instead of failing loudly.

    The fix, `typeAnchorFor`: the last operation in the range decides what
    it evaluates to, so the anchor is the last call's callee name (matching
    backward past one balanced `(...)`) or, with no trailing call, the last
    attribute name (`cache`, not `self`). Confirmed against the real
    disagreement before being treated as fixed: `self._make().step()`'s
    anchor is `step`, and asking there now agrees with `methodDeclarationAt`
    exactly. A field-kind regression this measurement's own fixtures had
    never exercised (`tests/resolution-python-lsp.test.ts` had no `self.x`
    test before this) turned out to share the identical bug -- every `field`
    receiver in the whole corpus had been asking about the wrong token.
    Withholding rather than guessing when the range ends in a subscript
    (`x[i]`'s element type is not this scan's to name) or in unbalanced
    brackets is `memberRangeAfter`'s own stance, reused rather than
    reinvented.

    **Reading two, after the fix: 85.5% get a declaring file, 1.76% of the
    ones that answer twice disagree.** Coverage moved down four points
    (89.6% -> 85.5%, 20,188 of 23,621) -- the subscript/unbalanced-bracket
    withhold trades a share of "an answer, possibly wrong" for "no answer,
    honestly." Wrongness moved from four times TypeScript's own 0.7% bar to
    *inside* the range this repo already ships a word on (item 12's
    1.1-2.0%): **1.76% (249 of 14,134)** -- 1.8% on `graphify` (244 of
    13,239), **0.6% on `infrarouter`** (5 of 895), better than TypeScript's
    own 0.7%. Read again rather than declared fixed on the strength of the
    percentage alone: every remaining disagreement on both corpora was
    pulled and categorised, not sampled. 81.6% (199 of 244 on `graphify`,
    all 5 of `infrarouter`'s) are item 14's own named shape restated in
    Python -- `.strip`, `.lower`, `.split`, `.get`: a receiver typed with a
    repo class narrows to a builtin at the call site, and `typeDefinition`
    on the receiver answers about the declared type, not the narrowed one.
    The rest -- `.expect(...)`/`.request(...)`/`.gpu(...)` on
    `infrarouter`'s own fluent-builder tests, `._platform_skill_destination`
    and similar private helpers on `graphify` -- are `typeAnchorFor`'s own
    honest remaining limit: a helper whose return type pyright infers
    rather than reads off an explicit annotation has no textual "Market" or
    equivalent anywhere in the *calling* file to point `typeDefinition` at,
    so asking about the callee's own name resolves to where the callee
    itself is declared -- correct when a fluent method returns `Self` (the
    fix's own win, confirmed live: hovering that exact position prints the
    full signature, return type included, and it is *only the file* that
    is unavailable through this protocol, not the type), wrong when a
    factory method returns a different class than its own. Confirmed by
    direct `hover`/`typeDefinition` probes at the exact position, not
    inferred from the pattern: no position in the caller's own text answers
    that second case honestly, the same "the reader and the referee share
    one limitation neither can see past" shape item 14 named for
    TypeScript's interface case, found here as a protocol limitation rather
    than a shared-checker one.

    **#236, reopened rather than left closed.** It was closed on reading
    one's number, per its own explicit instructions -- a bad number is a
    legitimate answer, and 2.8% against a 0.7-2.0% bar was one. Reading two
    is a different number, inside the bar rather than four times past it,
    found by treating "closed with the number written down" as reversible
    the same way #221's own TypeScript "no" was reversed by #230 once a
    better measurement existed. Whether 85.5%/1.76% is good enough to wire a
    live Python `declaringFile` into `resolveReceiver` or a Python
    `symbolDeclarationAt` into `@calls`'s closed-body check is #236's own
    question to answer now that it is reopened, not decided here.

    **What kind of number 1.76% is, stated after #250: self-consistency, not
    independence.** Both witnesses in sections 8-9 are pyright -- one
    `typeDefinition` on the receiver, one `definition` on the method, compared
    to each other. That is broad (it needs only one tool to answer twice, which
    is why it covers 70% of answers) and it is not useless: it is how the
    anchor bug above was found, because a harness that asks at the wrong
    position gets two answers that do not line up. What it cannot catch is
    pyright being wrong about a type, because a pyright mistake is made once
    and then reported by both witnesses. Item 14's 0.7% for TypeScript is the
    same kind of check and says so in its own limit paragraph. Item 18's
    placement figure is the other kind -- rust-analyzer against a reader that
    shares nothing with it -- and narrow for exactly that reason. So "0.7%,
    1.76%, 0.8%" is not one column; the first two are consistency figures and
    only the third is independent, over a quarter of its population. Item 20
    is where that stopped being true for Rust, and item 21 is where Python got
    an independent check -- and where it turned out that the wrong answers in
    this item's own 85.5% were never pyright's. Item 22 re-measured both figures
    once the client stopped returning those answers: **55.5% and 0.35%**, and
    most of what this entry reads as a narrowed builtin was one of them.

18. **Rust's version of the same ladder, and the safety check items 14 and 17
    used turns out to measure nothing in Rust -- so a different one was built,
    and it found three reader bugs (#246, after #237's spike).** The client is
    `scripts/lib/resolution-rust-lsp.ts`, rust-analyzer over `vscode-jsonrpc`
    per #237's recommendation, scoped to "only when rust-analyzer is already on
    the machine" -- no binary fetcher, silent skip on absence, `parse.ts`'s own
    stance for a missing grammar. Corpus: `rust-test`, `.corpus/anyhow` and
    `.corpus/ripgrep`, **9,098 receiver sites**.

    **Readiness cannot be inferred from the answers, and inferring it made the
    number worthless.** #237 named `-32801 content modified` as the not-ready
    signal and this issue's brief inherited it as *the* one to retry past. It
    is the last and shortest of several: `-32603 file not found` (the VFS has
    not loaded the file) and a plain `null` (loaded, not yet analysed) come
    first, so a client retrying only `-32801` records refusals for receivers
    rust-analyzer resolves correctly a second later. The first cut went further
    wrong by inferring readiness from answer *shape*: unlike pyright, whose
    "not ready" and "no answer" are the same `null`, rust-analyzer returns an
    empty array for a position it genuinely cannot place -- so `[]` could be
    final and fast and item 17's two-ladder retry would be unnecessary. Three
    workspaces polled at 100ms never showed `[]` before the first real answer,
    which read as confirmation and was three lucky samples: two runs of
    `measure:resolution` on identical input then reported **68.7% coverage and
    then 13.6%**, and one 50-site sample disagreed 30 times in one run and once
    in the other. rust-analyzer *publishes* readiness -- `$/progress` under
    `rustAnalyzer/cachePriming`, sent only when `window.workDoneProgress` is
    declared -- and its `end` is the moment queries answer. Waiting for it
    makes the first query correct every time (anyhow 3.3s over three runs,
    ripgrep 1.3s, `rust-test/orangutan_macro` 2.7s) and the run byte-identical
    across three. **A number that changes between two identical runs is not a
    slow number, it is not a number.**

    **Coverage: 74.3%, with a second denominator that is Rust's own.** Of
    9,098 receiver sites, **8,990 (98.8%) are inside a crate**, and that
    distinction is not a hedge: pyright answers about any `.py` file under a
    root, rust-analyzer only about files a `Cargo.toml` claims, and a tree can
    hold real Rust no crate owns (`rust-test/src` -- three `.rs` files, no
    manifest above them). Of those, **6,676 (74.3%) get a declaring file**
    against 21.9% for the syntactic reader, combined ceiling 77.3% -- the same
    shape of gap items 12 and 17 found.

    **The file-comparison safety check does not measure wrongness in Rust, and
    reading it is the only way that shows.** The check items 14 and 17 rest on
    -- where is the receiver's type declared, where is the method actually
    called declared, do they agree -- is good evidence in TypeScript and Python
    because a class and its methods share a file there. Rust separates them
    routinely and legally. Read one by one, **all 29 disagreements** on an
    early `rust-test`+`anyhow` run were **29 pairs of correct answers**, in
    three mechanisms: 24 an inherent `impl` block in another file (`anyhow`'s
    `pub struct Error` is `src/lib.rs:390`, `mod error;` is a different file
    and every method on `Error` lives in it), 4 a `core` trait's provided
    method on a repo type (`chain.skip(1)` -- receiver `anyhow`'s own `Chain`,
    `skip` declared in `core`), and 1 the inverse, a repo trait implemented for
    an external type (`x.parse().context(...)` -- receiver `Result` from
    `core`, `context` from `anyhow`'s own `src/context.rs`). Two further
    cautions came out of the same reading: that run's headline **11.5% was an
    artifact of measuring one small crate** whose author splits struct from
    impl -- with ripgrep in the corpus the same check reads **2.5% (166 of
    6,644)** -- and a first write-up of it claimed "0 wrong of 252" on the
    strength of having inspected the 29 disagreements, which does not follow:
    the other 223 were agreements nobody looked inside, and agreement is not
    evidence once the check is known not to discriminate.

    **What does not split is the type's identity, so that is what the real
    check compares -- over every answered site, not only the flagged ones.**
    `textDocument/typeDefinition` points at the type's own name token, so its
    target line is the declaration header and states the name. Two parts:

    - **Did it land on a type declaration at all?** It should always; an answer
      that is not one means the anchor resolved to something that is not a
      type, which is item 17's Python placement bug restated. **11 of 6,676
      (0.2%)**, and they are a named set rather than a mystery: a
      `lazy_static!` body, and `core`'s own `trait Into`/`trait AsRef` and
      `AtomicUsize` declarations, whose headers `declaredTypeOnLine` does not
      parse. By kind, the other 6,665 are 5,410 `struct`, 1,081 `enum`, 168
      `trait`, 6 `union`.
    - **Does it name the same type the syntactic reader read?** This is the
      referee proper and independent in the way `AGENTS.md`'s gate requires:
      `resolution.ts` reads a name out of text with no compiler, rust-analyzer
      resolves a declaration. **1,673 sites where both named a type, 53
      disagreed (3.2%)** -- and of those 53, **39 (73.6%) are one type wearing
      two names**, leaving **14, or 0.8% of sites checked**, as the figure
      actually comparable to item 12's 0.7% and item 17's 1.76%.

    **Two honest limits on that check, both worth stating before the number
    is.** It covers **1,673 of 6,676 answered sites (25.1%)**, and that is a
    ceiling rather than an oversight: an independent check needs the syntactic
    reader to have named a type too, and it names one for about a fifth of
    receivers, so three quarters of the answers have nothing independent to
    weigh them against. Asking rust-analyzer a second way does not fix it --
    `textDocument/hover` at the same position was tried and prints
    `range: &Match` for a `Range`-typed receiver, resolving through the same
    aliases and agreeing with `typeDefinition` by construction. A second
    opinion from the same server is not a referee.

    **A third limit, in the other direction, found reviewing this entry: the
    comparison is of bare names, so where a name is not unique the check
    cannot fully discriminate.** Everything above is about false
    *disagreements* -- aliases, qualified names, shapes, `cfg` arms -- and
    each is argued down carefully. The converse is not argued at all: an
    `agreed` verdict says the reader's name and the declaration's name are
    the same string, and in Rust a great many strings are not unique.
    Measured on this corpus, **129 of 524 type declarations (24.6%) share a
    bare name with a declaration in another file** -- `Error` in 15 files,
    `Config` in 8, `Match` in 4 -- and of the sites this referee can check,
    **164 of 1,757 (9.3%) name one of them**, `DirEntry` (49 sites) and
    `Match` (42) most of all. `Match` is the same type the alias paragraph
    below spends itself on, so this is not a hypothetical corner.
    A placement error that happened to land on a same-named declaration
    elsewhere would be scored `agreed` rather than caught, which makes the
    0.8% a **lower bound** on wrongness rather than an estimate of it -- the
    less comfortable direction for a figure being read against a 0.7% bar.
    It does not move the number: nothing here says any counted agreement
    *was* wrong, only that ~9% of them rest on weaker evidence than the
    other 91%. Closing it needs the referee to compare a type's identity
    rather than its name -- the declaring file and line
    `typeDeclarationLocationAt` already returns, which this comparison reads
    the header off but does not itself weigh -- and that is a change to the
    check rather than to the reader, so it is recorded here rather than
    fixed in the issue that found it.

    **The 39 are a type alias or an import rename, and separating them
    mechanically rather than by eye is what makes the 0.8% trustworthy.**
    `type Range = Match;` in `crates/searcher/src/searcher/mod.rs` accounts for
    **32 by itself** -- one line of ripgrep was 60% of a number about to be
    compared against 0.7%. With `type BagOfWords<'a> = BTreeSet<...>` and the
    import renames (`ContextSeparator as Separator`, `Worker as Deque`) it is
    39. rust-analyzer resolves through all of them and never reports the local
    name; the reader reports what the text says. Calling that a misread says
    the reader got wrong something it read correctly. **What it does not settle
    is the file**, which is what a board consumes: `Range`'s alias and
    `struct Match` are declared in different crates, and which one an arrow
    should point at is a design question, so both counts are printed rather
    than one being discounted.

    **The remaining 14 read through, and a third of them are already a filed
    bug.** Five are #247's shadowed parameter (`fn select(&mut self, name:
    &str)` shadowed by `for name in ...`; `caps: &mut RegexCaptures` rebound by
    `let caps = caps.captures_mut()`; `lines: &str` by `let mut lines:
    Vec<&str>`), so the comparable figure falls to about 0.5% once that is
    fixed. Three are an associated-type projection (`Self::Captures` against
    the `trait Matcher` that declares it), two a generic bound versus the
    concrete type behind it (`impl AsRef<Path>` naming the trait), two
    conditional compilation (below), and two narrowing through a chain
    (`.into_iter()`, `.peekable()`) -- item 14's own named shape restated in
    Rust. None of the nine non-#247 cases is a wrong file claimed about a type
    that does not exist; each is two answers to questions that differ.

    **A first reading of that check said 12.6%, and two thirds of that was the
    comparison being naive rather than either side being wrong** -- the same
    trap as the 11.5%, one level in. `resolution.ts` deliberately keeps a
    qualified name whole (`fmt::Formatter`, `process::Command`) while a
    declaration header states the bare name, so every qualified annotation read
    as a disagreement; and `Array` is a *shape* the reader names for `[T; N]`,
    which has no declaration for rust-analyzer to land on, so comparing them is
    a category error. Normalising the first and setting aside the second (16
    sites) leaves the 3.2%.

    **Three real reader defects came out of the reading, and all three were
    reproduced from a parse tree or a minimal case rather than inferred from
    the pattern:**

    - **A lifetime read as the type. Fixed.** `&'static dyn Flag` parses as
      `reference_type(lifetime(identifier "static"), dynamic_type(...))`, the
      lifetime comes first in child order, and `headTypeOf`'s leaf-`identifier`
      fallback took it -- so *every* reference carrying an explicit lifetime
      named the lifetime as its type: `'static` as `static`, `'a` as `a`,
      confidently, with no refusal. `docs/reading-a-grammar.md`'s rule exactly:
      the fix is structural (a `lifetime` is never a type), because no list of
      type-node names would have mentioned `lifetime`.
    - **A generic type's `impl` block lost its fields. Fixed.**
      `impl<'a> Holder<'a>` and `impl<T> Foo<T>` put a `generic_type` on the
      `type` field, and the declaration lookup required a childless node -- so
      every `self.field.method()` inside a generic type's impl was withheld as
      `no-fields`. Honest rather than wrong, so nothing ever went red over it;
      it cost coverage silently on exactly the types most likely to carry
      fields worth reading. `conforms.ts`'s `baseNameIn` already reads the
      applied name of a `generic_type`; reused rather than reinvented. **The
      two fixes together took tier 1 from 19.0% to 21.9% of in-crate
      receivers, 264 more sites resolved.**
    - **A shadowed parameter outranks the binding that shadows it. Found,
      reproduced, NOT fixed here -- and it is not a Rust bug.**
      `resolveReceiver` consults `scope.params` *before* `scope.bindings`, so
      `fn g(cwd: Thing) { let cwd = Other::new(); cwd.run(); }` reports
      `Thing`. Confirmed in TypeScript with the same shape, so items 12-14 and
      17's own numbers were measured with this defect present and it is a share
      of their 0.7% and 1.76% rather than something Rust exposed. ripgrep's
      `fn select(&mut self, name: &str)` shadowed by `for name in
      self.types.keys()` is the corpus instance, and `impl Into<PathBuf>`
      rebound by `let cwd = cwd.into()` is a second. The conservative fix is to
      withhold as `reassigned` when a parameter name is also bound in the body
      -- but it is left to its own issue on purpose, because it changes the
      TypeScript and Python readings too and `AGENTS.md` wants that cost
      measured per language rather than folded into a Rust issue.

    One more divergence worth recording because it is Rust-only and not a bug
    on either side: **conditional compilation.** `crates/ignore/src/pathutil.rs`
    declares `fn imp` twice, `#[cfg(unix)]` and `#[cfg(not(unix))]`.
    rust-analyzer resolves only the active arm; the syntactic reader reads both
    bodies, having no notion of a cfg. Answers about an inactive arm are
    therefore not comparable, which is a limit on any referee built this way
    rather than an error to fix.

    **What #246 settles, and what it does not.** Settled: the client works,
    across crate boundaries and through macro expansion; the numbers are
    reproducible across three runs; **74.3%** of in-crate receivers get a
    declaring file; and the wrongness figure comparable to the other two
    languages is **0.8%** (14 of 1,673), falling to about **0.5%** once #247 is
    fixed -- at TypeScript's 0.7% and below Python's 1.76%, with every one of
    the 53 disagreements read and every one of the 14 attributed to a named
    cause. Not settled, and deliberately not decided here:

    - **Which file an aliased type should be attributed to.** 39 of the 53 are
      a local name for a type declared elsewhere, and a board points at a file.
      Nothing here decides whether that arrow belongs at the alias or at the
      underlying declaration, and the answer is not obviously the same for a
      `type X = Y` as for a `use ... as X`.
    - **Whether 25.1% check coverage is enough to wire anything on.** The
      figure above is sound for the sites it covers; three quarters of the
      answered sites are unrefereed, and no second question asked of the same
      server can change that. Raising it means a stronger *independent* reader,
      which is #203's territory rather than this issue's. **Answered in item
      20**, and by a route neither this entry nor #250 proposed: not a stronger
      reader but a second oracle, `rustc` itself, which covers 90.9% and finds
      the unchecked three quarters no worse than the checked quarter. The
      figures in this entry stand as what *that* check measured; item 20's are
      the ones about the whole population.
    - **#247**, the shadowed parameter. Predicted here to move TypeScript's and
      Python's published numbers too; item 19 measured it and **it moves
      neither on this corpus** -- no instance of the shape occurs in the
      ts/tsx/js trees (it is expressible there, as a nested-block shadow --
      see item 19), and Python's rebindings here are type-preserving. Rust's
      own figure went 0.8% -> 0.4%.

19. **A shadowed parameter outranked the binding that shadows it, and fixing it
    halved Rust's wrongness while costing Python 103 correct answers for no
    measured gain (#247).** `resolveReceiver` consulted `scope.params` before
    `scope.bindings`, so `fn g(c: Thing) { let c = Other::new(); c.run(); }`
    reported `Thing` -- confidently, no refusal. Found by item 18's
    rust-analyzer referee, which is what that check was built for.

    Two defects behind one symptom, and the second only showed up because the
    first fix did not close the corpus case. **Precedence:** a name that is both
    a parameter and a body binding is two candidate types, and this reader has
    no positional scoping to say which is live at the call, so it now answers
    `reassigned` -- the word already used when one name has two bindings.
    **Invisible bindings:** a `for` pattern was never collected as a binding at
    all, so a bare loop variable came back `unbound` (untrue -- it is plainly
    bound) and a parameter shadowed by a loop variable had nothing competing
    with it. That was ripgrep's `fn select(&mut self, name: &str)` shadowed by
    `for name in self.types.keys()`. The loop variable is recorded with **no
    type on purpose**: `for c in v.iter()` binds an *element*, and classifying
    it from the iterable would name the receiver `Iter`, trading one wrong
    answer for another.

    **Blast radius, checked before the numbers: none of this ships.**
    `resolveReceiversIn` has exactly one caller, `scripts/measure-resolution.mts`
    -- `drift.ts`'s own `noteWithheld` takes a `SignatureWithheld`, a different
    type, and the live Python guard (#243) goes through pyright's LSP, not this
    reader. `calls.ts` resolves *names to files* with its own `Bindings`, which
    is a `Set<string>` plus an `ambiguous` set and never a type, so it does not
    share the defect. So this bug never drew a wrong arrow. What it corrupted is
    the numbers this document uses to decide whether a language may accuse --
    including two of the bars themselves.

    **The cost, per language, measured rather than estimated.** Corpus: this
    repo's `src` and `scripts`, `rust-test`, `graphify`, `infrarouter`,
    `ripgrep`, `anyhow` -- 39,250 receiver sites. Baseline and fixed runs
    differed in exactly one file, with the harness commit and the measured
    sources held byte-identical.

    | language | tier-1 coverage | wrongness |
    |---|---|---|
    | rust | 22.2% -> 21.3% (-76 sites) | item 18's placement check **14 -> 7 (0.8% -> 0.4%)** |
    | ts | 26.0% -> 26.0% (unchanged) | 13 -> 13 (0.8%, unchanged) |
    | tsx / js | unchanged | 0 -> 0 |
    | python | 14.2% -> 13.8% (-108 sites) | 43 -> 43 (1.3%, unchanged) |

    **Rust is the whole benefit, and it is a real one:** every one of the seven
    disagreements removed was this bug, and the seven that remain contain no
    shadowing at all -- three associated-type projections, two `#[cfg]` arms,
    two narrowings through a chain. Two of the seven had been filed under
    "generic bound versus concrete type" in item 18 and were shadowing as well
    (`impl Into<PathBuf>` rebound by `let cwd = cwd.into()`), so that item's own
    categorisation was slightly wrong and the fix caught more than it predicted.

    **TypeScript's numbers did not move, but not because TypeScript is immune
    -- a third false claim, found the same way as the other two.** #247 was
    filed saying the bug was cross-language, and the reproduction that
    convinced its author -- `function g(c: Thing) { const c = new Other(); }`
    -- is indeed not valid TypeScript, since a parameter cannot be
    *redeclared* in its own scope. A first write-up of this entry concluded
    from that "TypeScript does not have this bug," which does not follow: a
    parameter can be **shadowed in a nested block**, which is valid
    TypeScript and is the identical shape. Demonstrated against this reader
    rather than argued:

        function g(c: Thing) { { const c = new Other(); c.run(); } }
        function g(c: Thing, xs: Other[]) { for (const c of xs) { c.run(); } }

    Both resolved `c.run()` to `Thing` -- the parameter -- before this fix,
    and both withhold as `reassigned` after it. The fix changes ts/tsx
    behaviour, which is itself the evidence: were TypeScript immune it would
    be a no-op there.

    What is true is narrower and is the claim that belongs on the record:
    **nothing in ts/tsx/js moved on this corpus**, because no instance of
    either shape occurs in it -- plain reassignment (`c = x`) is collected and
    would be caught, and also occurs nowhere here. Item 12's 0.7% is
    untouched as a measured number. It is not evidence that the shape cannot
    arise, and a later change that alters parameter or binding precedence
    should re-check ts/tsx rather than reason from immunity.

    **Python pays and gets nothing, and that is the finding worth arguing
    with.** Of the 108 sites it stopped resolving, **103 were sites where
    pyright agreed with the parameter's type** and 5 were already refused --
    **zero wrong answers removed.** Python rebinding is usually
    type-preserving (`x = x.strip()` is still `str`), and nothing distinguishes
    that from `cwd = cwd.into()`, which is not: both are a parameter plus a
    binding this reader cannot type. Falling back to the parameter when the
    binding is unresolvable would restore all 103 *and* restore the Rust bug,
    because `let cwd = cwd.into()` is exactly that shape. So the refusal stands
    on the argument `licence.ts` is built on rather than on a number: a
    confident wrong answer is not recoverable and a refusal is. **On this
    corpus, in Python, it buys nothing measurable.** A corpus where a Python
    rebinding does change the type would show it; this one has none.

    Item 17's 85.5%/1.76% cannot move and were not re-measured, which is a
    structural fact rather than an omission: sections 8-9 compare two pyright
    answers to each other and never consult this reader (`tier1Resolved` feeds
    only the reported tier1/combined columns). Confirmed in the code before
    being relied on, and `measure:resolution` grew a `--no-python-lsp` flag so
    the next change to this reader need not spend the 687 seconds and 22,449
    round trips that pass costs on `graphify` alone. `~/mundane` is out of this
    run for item 17's own stated reason -- its per-package TypeScript analysis
    runs past thirty minutes before any other section starts -- which leaves the
    TypeScript sample smaller than item 12's and is why "unchanged" above is
    stated for this corpus rather than for TypeScript at large.

    **The remaining limit, pinned as a test rather than left to be
    rediscovered:** a destructuring pattern (`for (a, b) in ...`) has children
    and is skipped the way every other binding shape here skips one, so a
    parameter shadowed by a tuple pattern is still reported as the parameter.

20. **The referee item 18 could only run on a quarter of its answers now runs on
    91% of them, because rustc will type any receiver it compiles -- and the
    hard three quarters came back as good as the easy one (#250).** Item 18's
    check needs `resolution.ts` to have named a type as well, and it names one
    for about a fifth of receivers, so `0.4%` was a figure about annotated
    parameters, constructors and declared fields. #250 was filed on the
    suspicion that the unchecked majority -- chains, values out of calls,
    untraced names -- might be worse. Measured: it is not.

    **The mechanism, and it is not `reveal_type`.** Rust has no "print this
    expression's type" request. What it has is an error that names one.
    `scripts/lib/resolution-rustc.ts` wraps every receiver in a block that calls
    a method reachable only through a blanket impl gated on a trait nothing
    implements, so the receiver's own value flows out unchanged and the build
    fails at exactly that expression with `the method ... exists for struct
    \`X\`, but its trait bounds were not satisfied`. That message states the
    type, and its secondary span is the type's own declaration -- which is what
    makes this comparable to `textDocument/typeDefinition` at all. Two message
    shapes, both read: the one above, and `no method named ... found for ...`,
    which rustc uses where no impl candidate exists (a type parameter, and a
    long tail of concrete types) and which names the type but points at no
    declaration.

    **Compared by declaration, not by name**, which also closes item 18's third
    limit rather than restating it: 24.6% of that corpus's type declarations
    share a bare name with another, so a name match was weaker evidence than it
    read as. File and line are not ambiguous.

    **Three things the plan had wrong, all found by running it.**

    - **What a probe is called is a performance property.** The first names were
      `__probe_0`, `__probe_1`, and every failed call makes rustc search for a
      similarly-named method to suggest -- so each probe searched all the
      others. 100 probes built in 1.6s, 200 in 5.9s, 400 in **266s**, and one
      ripgrep crate ran past half an hour before it was killed. Six-letter names
      scrambled by a bijection on 26^6 share nothing but their prefix: 400 in
      0.8s, 800 in 1.8s, the whole 8,623-site corpus in 42s. Pinned by a test
      that computes the edit distance between generated names rather than by a
      comment, because the failure is invisible until a corpus is large.
    - **One package at a time, and the obvious repair is the one that loses
      data silently.** Every probe is a compile error, a crate with errors emits
      no metadata, and nothing downstream of it is ever type-checked -- so
      probing a whole workspace answers for its leaves and nothing above them.
      The first repair was to restore what had answered and build again, which
      lost **923 of 1,246 sites in ripgrep's printer**: a crate's library builds
      without its dev-dependencies and its unit tests do not, so the file
      answered on its library pass, was restored, and its `#[cfg(test)]` module
      was never asked again. Each package is now built alone with only its own
      files probed, and a second pass probes what did not answer -- which is
      what reaches a package's binaries and integration tests, blocked the first
      time by the library they link. Both shapes are pinned as tests against a
      real three-package workspace.
    - **`cargo metadata --offline` resolves every platform's dependencies**, so
      it fails on the first one this machine never fetched -- ripgrep on
      Android's `android_system_properties`, anyhow on Windows' `r-efi`. That
      read as "cargo refused the package listing" for all three trees and
      checked **zero** sites, which the report now says in as many words rather
      than printing a small number. `--filter-platform <host>` is the fix; the
      build only ever compiles for the host.

    **The numbers.** `npm run measure:resolution -- --no-python-lsp --all
    rust-test .corpus/ripgrep .corpus/anyhow`, section 13, rustc 1.93.0, 22
    probed builds. Of 6,676 rust-analyzer answers:

    | what the syntactic reader said | answered | checked | disagreed | macro | wrong |
    |---|---|---|---|---|---|
    | resolved -- item 18's whole population | 1,663 | 95.8% | 1 | 0 | 0.1% |
    | `not-a-name` | 2,523 | 95.0% | 10 | 9 | 0.0% |
    | `from-a-call` | 1,065 | 93.9% | 6 | 6 | 0.0% |
    | `unbound` | 770 | 65.3% | 3 | 3 | 0.0% |
    | other withholds | 655 | 87.3% | 0 | 0 | 0.0% |
    | **all** | **6,676** | **90.9%** | **20** | **18** | **0.03%** |

    **18 of the 20 disagreements are one type a macro declares, and neither tool
    is wrong about it.** rustc names the line inside the `macro_rules!` body
    that writes the declaration; rust-analyzer names the invocation that
    supplies the name. `core`'s `str::Split` (`pub struct $forward_iterator`
    against `struct Split;`) is most of them, `AtomicUsize` and `lazy_static!`'s
    `ROUTES` the rest. `declaredByMacro` requires rustc's line to use a
    metavariable *and* rust-analyzer's to name the very type rustc printed, so a
    macro body alone never excuses a different type -- the condition that
    carries the weight, and the one its tests aim at.

    **Both remaining disagreements were read against the source, and
    rust-analyzer is wrong in both.** `crates/ignore/src/walk.rs:704` --
    `self.paths.clone()`, where `paths: Vec<PathBuf>` is declared on line 489 --
    rustc says `Vec<PathBuf>`, rust-analyzer says `IntoIter`, the type of the
    *whole* surrounding expression. `crates/cli/src/decompress.rs:511` --
    `args.iter().skip(1).map(..)` -- rustc says `Skip<slice::Iter<'_, &str>>`,
    rust-analyzer says `Vec`. The second is in `not-a-name`, which is to say it
    is a real error that no check before this one could see.

    **Two guards on the check itself, because a referee that agrees with
    everything is not a referee.** Pairing each answer with the compiler's
    verdict on an unrelated site half the corpus away agrees **1.3%** of the
    time, so 99.7% agreement is discrimination rather than a check that cannot
    tell types apart. And item 18's own verdicts, re-read on the sites both
    reach: of 1,554 it called agreed, rustc overturned **none**; of the 39 it
    flagged, **38 were false alarms** and one was real -- which is the alias
    finding restated from the other side, by a mechanism that does not depend on
    it.

    **What is still unchecked: 610 answers (9.1%).** 78 rustc never typed --
    compiled by no target the build checks, an inactive `cfg` or a feature left
    off. 532 it typed as something no declaration states, by its own word: 200
    `struct`, 181 `reference`, 57 `enum`, 49 `associated type`, and a tail. Most
    are the second message shape above, where the type is named (`Option<T>`,
    `Vec<_>`, `PathBuf`) and no declaration span comes with it. Closing that
    needs a different question, not a different referee.

    **The 90.9% needs the standard library's source on the machine.** rustc
    points a `std` type at its declaration only when the toolchain carries
    `rust-src`; without it `Vec` is typed and declared nowhere, and every such
    answer falls into the unchecked column. CI found it rather than a reading of
    the code: the runner had no `rust-src`, and a test expecting `vec/mod.rs`
    failed there alone. The reading now records whether the source was present
    (`hasStdSource`, asked of the same `rustc` with the same `RUSTFLAGS` cargo
    passes), and section 13 says so in as many words when it was not, so a lower
    coverage figure from such a machine cannot read as a finding.

    **What rustc and rust-analyzer share, stated rather than assumed.** Name
    resolution, macro expansion and type inference are separate implementations
    -- that is the whole basis for calling this independent. rust-analyzer does
    vendor the crates of rustc's next-generation trait solver; a stable rustc
    does not use that solver to type-check bodies, so on this toolchain trait
    resolution is separate too. On a toolchain that turns it on it would not be,
    and the compiler version is part of the number for that reason.

    **What this does not settle.** It does not turn Rust on -- the licence
    decision is not here, and item 18's open question about whether an arrow
    belongs at an alias or at the underlying declaration is untouched. And it is
    one language: **TypeScript and Python still have no independent check at
    all** (see item 17's closing paragraph), which is now the whole of what #250
    named and is filed as its own issue rather than left implied.

21. **Python's version of item 20: mypy checks 61.8% of pyright's answers
    independently -- and the wrong answers it finds are not pyright's
    mistakes about a type, they are our client's, and none of them is among
    the answers item 17's check called agreements. TypeScript has no second
    oracle to ask (#258).**
    Item 17's closing paragraph says what 1.76% is: pyright asked two questions
    and compared with itself, which cannot catch pyright being wrong. #258 asked
    whether that was hiding anything.

    **The mechanism.** `scripts/lib/resolution-python-mypy.ts` puts a
    `reveal_type` around every receiver in a copy of the tree and reads one
    mypy run -- one, not rounds, because a probe here is an expression rather
    than Rust's deliberate compile error. Two details are load-bearing and both
    were found by running it. **Every probe carries its site's own id** as a
    `Literal` in a tuple, because mypy prints one note per distinct message per
    line: two receivers of one type on one line reported once, and the second
    site silently had no answer. And **`--check-untyped-defs`**, because by
    default mypy does not look inside an unannotated function and the probe
    comes back a bare `Any` with its tag stripped, so the site cannot even be
    identified -- the corpus quietly shrinks to its annotated half. Answers are
    compared by declaring file, which is what item 17 compares and what a board
    points at. A third bug was in this referee's own index and is the kind that
    never announces itself: types were looked up only among files that carry a
    probe, so a type declared in a module with no receivers of its own matched
    a shorter prefix and came back declared in `graphify/__init__.py`. A wrong
    file, not a missing one; every `.py` file is indexed now. The fourth was
    in the same lookup: mypy prints a class declared inside a function with
    the line it sits on (`tests.test_llm_backends._SubPath@229`), the suffix
    names no module, and the class read as declared outside the tree -- a
    disagreement with pyright that was this referee's own misreading, caught
    because the write-up refused to fill while one disagreement fitted none
    of the shapes it names.

    **The numbers.** `npm run measure:resolution -- --all graphify infrarouter`,
    section 14, mypy 2.3.1 against pyright 1.1.406, 20,065 pyright answers:

    | what the syntactic reader said | answered | checked | disagreed | wrong |
    |---|---|---|---|---|
    | resolved | 3,132 | 93.2% | 36 | 1.2% |
    | `not-a-name` | 2,057 | 86.2% | 182 | 10.3% |
    | `from-a-call` | 2,686 | 43.0% | 39 | 3.4% |
    | `unbound` | 3,786 | 30.8% | 20 | 1.7% |
    | other | 8,404 | 64.2% | 906 | 16.8% |
    | **all** | **20,065** | **61.8%** | **1,183** | **9.5%** |

    7,653 are unchecked because mypy typed them `Any` -- declining, not
    agreeing -- which is unannotated Python even with `--check-untyped-defs`.

    **The counts move between identical runs, and by more than a rounding.**
    Across the runs of this section, pyright answered 20,064, 20,065, 20,040 and
    20,065 sites; the low one ran alongside the full test suite. Every figure in
    this entry is from one run, the last, on an idle machine, and none is
    combined with another's.

    **723 of the 1,183 are two right answers.** A module used as a receiver
    (`extract_mod.extract(...)`) is `types.ModuleType` to mypy and the module's
    own file to pyright, and the second is the file a board wants.
    `isModuleReceiver` classifies them out, the way `declaredByMacro` does in
    Rust.

    **Item 17's agreements hid nothing.** Re-read on the sites both reach, mypy
    disagreed with 675 of the 11,705 answers item 17 called agreements, and
    every one of them is a module receiver. Of the 237 it flagged, mypy backed
    pyright on one. So on this corpus 1.76% was not an undercount dressed as a
    consistency figure: its agreements were right.

    **Whether this check discriminates, which is a smaller claim than it was
    in Rust.** Paired with mypy's verdict on an unrelated site, pyright's answer
    agrees 82.1% of the time: most answers on both sides are outside the
    repository, and "neither of us thinks this type is yours" is what two
    unrelated receivers share. So agreement *outside* the repository is close to
    no evidence, and this entry leans on none of it. Restricted to answers
    pyright placed inside the repository, unrelated pairs agree 0.0%
    against 30.7% for real ones: inside the repository the check does tell
    answers apart. Real agreement is that low because most of those answers are
    the wrong files counted below, not because mypy and pyright name files at
    random.

    **The 460 that are not module receivers are a wrong file, and every one is
    our client's.** 379 are mypy naming a builtin (`str`, `dict[...]`) against a
    file in the repository, 79 `pathlib.Path` against one, and 2 infrarouter's
    `Market` against the test that builds it. Asked directly rather than
    inferred, pyright is not confused about any of them. Where its own type is
    `Unknown`, `textDocument/typeDefinition` falls back to the receiver's
    bindings -- `a` in `cli.py` answered with nine locations, all `a = args[i]`
    -- and `firstLocation` takes the first as a declaring file. Where the
    receiver ends in a call, `typeAnchorFor` anchors on the callee's name and
    pyright correctly answers where the callee is (`def out_path(...) ->
    Path:`, its hover stating the `Path`) -- the limit item 17 named, larger
    than it looked. 269 of the 460 are sites item 17's check never
    reached, because `definition` on the method answered nothing there; the
    other 191 it had flagged without being able to say which answer was wrong.
    Where pyright's answer does land on a real class in the repository, mypy
    agrees on all 131.

    **So the check that matters is the one that needs no second oracle: did
    the answer land on a type declaration at all?** Rust's item 18 a), asked of
    Python, over every answer. `pythonDeclarationKind` reads the target line as
    a type, the top of a module, or neither:

    | pyright's answer | answers | a type | top of a module | declares no type |
    |---|---|---|---|---|
    | in the repository | 7,104 | 131 | 724 | **6,249** |
    | outside it | 12,961 | 9,869 | 2,389 | 703 |

    Grouped by what the line holds, the in-repository ones are the fallback and
    the callee anchor: 3,101 assignments, 1,868 `def` lines, 1,049 loop
    variables, 42 `with ... as` bindings, and 189 left over. That last group was
    sampled by hand rather than read in full, and every line sampled was a
    binding too -- a lambda or comprehension variable, or a parameter on a
    continuation line. **Item 17's 85.5% coverage counts 6,249 answers that are
    not a declaration**, and 394 of mypy's in-repository agreements are a line
    that declares no type in the file where mypy's type happens to be declared
    too -- agreement
    by file that is not evidence, item 18's lesson about names restated for
    files.

    **None of it reaches a board.** Traced rather than assumed: a pyright answer
    reaches the engine only through `placeThroughChecker`, called only from
    `placeOf`, called only from `callSitesIn`, whose only caller is
    `closedBodyRefutes` -- and that returns `undefined` on `concrete === false`
    before it reads the file. `isConcreteClassLine` answers `undefined` for every
    one of these lines, which `resolution-python-live.ts` turns into
    `concrete: false`; `resolution-python-live.test.ts` already pinned the
    unannotated-parameter shape. What was wrong was this document's number.
    Withholding them in the client is filed as #259 rather than done here,
    because it moves item 17's published coverage and `AGENTS.md` wants that
    cost measured. Done, and measured, at item 22.

    **TypeScript: there is no second oracle, and that is the answer.** The one
    independent implementation, `ezno` 0.0.23 (last released 2024-11-13), stops
    at a parse error on **10 of the first 20** files in `src/engine`, taken
    alphabetically -- a union written with a leading `|`, and a non-null
    assertion (`bodies[0]!.line`) -- in a project `tsc` accepts cleanly. It
    never reaches a type. `@typescript/native-preview` is Microsoft's port of
    the same compiler, the same analysis in another language: #250's `hover`
    lesson, a second opinion from one source. So item 14's 0.7% stays a
    self-consistency figure, and the cost is stated rather than implied: a
    `tsc` mistake about a type is invisible to every check here. #236's
    precedent -- a bad answer written down is a complete answer.

    **The five figures, as the kinds of number they are:**

    | language | check | kind | answers checked | wrong |
    |---|---|---|---|---|
    | TypeScript | item 14 | self-consistency: `tsc` asked twice | -- | 0.7% |
    | Python | item 17 | self-consistency: pyright asked twice | 70% | 1.76% |
    | Python | item 21 | independent: mypy | 61.8% | 3.7% (460 of 12,409) |
    | Rust | item 18 | independent, narrow: our own reader | 25.1% | 0.4% |
    | Rust | item 20 | independent: `rustc` | 90.9% | 0.03% |

    Python's independent figure is higher than its consistency figure, and the
    difference is not pyright: it is the client's wrong files, on sites item
    17's check either never reached or flagged without being able to settle --
    and the placement table above counts them in full, oracle or not.

22. **#259: the client no longer answers with a line that declares no type,
    and most of item 17's disagreements were that line. 84.9% → 55.5%
    answered, 1.76% → 0.35% disagreeing, and mypy's 460 wrong files → 0.**
    `askTypeLocation` in `scripts/lib/resolution-python-lsp.ts` reads the line
    `textDocument/typeDefinition` pointed at with `pythonDeclarationKind` and
    withholds `not a type`, in the repository or out of it; `type` and `module`
    are kept. `tests/resolution-python-lsp.test.ts` has one test per line the
    fallback really landed on -- an assignment, a `for` target, a parameter, a
    `with ... as`, a lambda parameter, a callee's `def` -- and each failed first
    on the exact line pyright returned.

    **Before and after.** `npm run measure:resolution -- ~/board-ai/graphify
    ~/infrarouter`, run back to back on an idle machine, pyright 1.1.406, mypy
    2.3.1. The before run reproduced item 21's figures exactly (20,065 answers,
    6,249, 14,134/249), so the two compare:

    | | before | after |
    |---|---|---|
    | pyright answered (section 8, `lsp`) | 20,065 (84.9%) | 13,113 (55.5%) |
    | with the syntactic reader (`combined`) | 20,186 (85.5%) | 13,342 (56.5%) |
    | withheld: the line declares no type | -- | 6,952 |
    | in-repository answers declaring no type (14 f) | 6,249 | 0 |
    | answers outside it declaring no type | 703 | 0 |
    | section 9: checked, disagreed | 14,134, 249 (1.76%) | 12,906, 45 (0.35%) |
    | mypy: checked | 12,409 (61.8%) | 11,023 (84.1%) |
    | mypy: disagreed, not a module receiver | 460 | 0 |
    | mypy typed it `Any` | 7,653 | 2,087 |
    | pyright pass on graphify | 429s | 268s |
    | whole run | 9m40s | 6m53s |

    **The cost is 6,952 answers, 29.4 points of coverage.** 6,249 were in the
    repository and never a declaration. The 703 outside it are a callee's `def`
    in typeshed or a package; the type a call there returns is usually outside
    the repository too, so the old answer's `external` was often right by
    coincidence, and a library function can still return a repository type.
    One loss is visible in a test: `self._make().step()` was answered with `def
    step`, right only because `Builder` shares that file, and now has no answer.
    Faster because a withheld type answer skips section 9's second question.

    **What it overturns: item 17's reading of its own disagreements.** 204 of
    the 249 are gone, and the fix does nothing but withhold type answers -- so
    they were the fallback, not "a receiver typed with a repo class that narrows
    to a builtin". `graphify/analyze.py:103 .endswith(...)`,
    first on that list with the receiver's type "in `analyze.py`", was pyright
    pointing at line 102, `src = (attrs.get("source_file") or "").lower()`. The
    45 left are all module receivers: mypy counts every one of its 723 remaining
    disagreements as one, these 45 among them. The twelve printed are a module
    that re-exports the function from another file -- `graphify/__main__.py`
    against `install.py`, `extract.py` against `extractors/fortran.py` -- two
    right answers.

    **What it does not change.** No board: these answers came back `concrete:
    false` and could not accuse, and now there is no answer, so the call stays
    unplaced and its body open -- fewer closed bodies, never a new accusation
    (`resolution-python-live.test.ts` pins both the unannotated receiver and a
    module receiver). `mayAccuse` reads whether a row is measured, not its
    figures, so Python's `@calls` absence licence stays granted; its counts are
    restated from this run.

    **Named, not folded in:** what a call *returns*. A receiver ending in a call
    is unanswered wherever the anchor is the callee. `hover` prints the return
    type; no request here gives its file.

    | language | check | kind | answers checked | wrong |
    |---|---|---|---|---|
    | Python | item 17, restated | self-consistency: pyright asked twice | 98.4% (12,906 of 13,113) | 0.35% |
    | Python | item 21, restated | independent: mypy | 84.1% | 0.0% (0 of 11,023) |

23. **Item 13's reversal does not generalise. Python closes a quarter of its
    call bodies with a real checker and Rust a sixth, against TypeScript's
    half — and Rust's is low with the *best* reach of the three, which is the
    part that says something (#256).** Item 13 reversed #221's "don't build it"
    on one number, 10.6% → 50.3%, and `measure:closed-bodies` asked that
    question of ts/tsx/js only, because TypeScript was the only language with a
    tier-2 resolver when it was written. Python got one at #235/#243 and Rust at
    #246; `TIER2_LANGUAGES` never grew. So half of call bodies closing was on
    the record as the result of this arc while nobody had asked the other two.

    `npm run measure:closed-bodies`, whole corpus, 15,588 bodies:

    | language | with calls | closed, text alone | closed, tier 2 |
    |---|---|---|---|
    | ts | 2,075 | 8.7% | **53.3%** |
    | tsx | 489 | 17.2% | 36.0% |
    | js | 78 | 6.4% | 6.4% |
    | python | 8,786 | 13.9% | **25.7%** |
    | rust | 2,416 | 3.0% | **16.1%** |
    | all | 13,844 | 11.3% | 28.4% |

    ts/tsx/js together are 48.8% against item 13's 50.3%. Not a change from
    anything here: `mundane` and `infrarouter` are unpinned and have moved since,
    which PR #238 already recorded when the same drift showed up in a different
    figure.

    **The reach each number rests on, which is what makes a low one readable.**
    `declared + external` over the queries actually asked:

    | language | queries | never asked | asked | answered | reach |
    |---|---|---|---|---|---|
    | ts | 9,580 | 0 | 9,580 | 7,860 | 82.0% |
    | tsx | 1,897 | 0 | 1,897 | 1,541 | 81.2% |
    | python | 31,872 | 0 | 31,872 | 20,960 | 65.8% |
    | rust | 12,193 | 5,013 | 7,180 | 6,404 | **89.2%** |

    **Never asked is kept out of the denominator on purpose, and it is 41% of
    Rust's queries.** 2,529 are a type used as a path — `String::new()`,
    `std::str::from_utf8(..)`, which is how Rust writes a constructor and a free
    function, so there is no value at that position whose type could be declared
    anywhere. (A type the file imports by name is placed by the reader's own
    name search and never reaches the resolver at all — found by a fixture that
    produced no such query until it used a prelude type, not by reading the
    code.) 1,553 are a
    receiver `rustTypeAnchorFor` places no cursor in at all (a subscript, a
    trailing `?`, a trailing path call), for the reasons #246 measured. 922 are
    `mundane`'s Rust, which no `Cargo.toml` claims, so rust-analyzer has no
    crate graph to answer from. Counting any of them as refusals would report
    Rust's constructor spelling as the resolver failing.

    **So Rust's 16.1% is not about reach.** rust-analyzer answers a higher share
    of what it is asked than `tsc` does, and Rust still closes a third as many
    bodies. On `ripgrep` alone, after tier 2, `receiver` is still the sole
    blocker in 26.5% of open bodies and `unbound` in 13.1%, with a `macro`
    doubt present in 820 more. The constructors that were never asked are
    exactly those remaining `receiver` blocks: `let x = Foo::new(); x.run()`
    leaves the reader nothing, and the resolver is not asked because the text
    names a type rather than a value. Rust's closed region is small because of
    how Rust is written, not because rust-analyzer declines to answer — which is
    the opposite of what a bare 16.1% beside 89.2% invites a reader to assume.

    **Python's quarter is honest and lower than it would have been last week.**
    6,575 answers are withheld by #259's rule, whose whole point is that they
    were never a type's declaration. Measured before that fix, Python's share
    would have been higher and part of it would have rested on a wrong file.
    After tier 2, `receiver` is still the sole blocker in 28.4% of open Python
    bodies and `unbound` in 26.3%, so the same wall stands one language over.

    **Cost, since this is now the most expensive measurement here.** 5m41s for
    the whole corpus, 187s of it language-server time. Two full readings gave
    identical closed shares and reach in every language, so unlike item 21's
    pyright counts these do not move between runs. pyright answered 216 queries
    a second on `graphify`; rust-analyzer answered about 1,600, because it
    serves a warm index where pyright re-analyses — the reason Rust's whole
    10,421-query pass on `ripgrep` takes five seconds and Python's takes a
    hundred.

    **The interface guard's cost, per language (#233).** A closed body carrying a
    placement whose type is not concrete is withheld rather than accused from:
    ts 12.8%, tsx 4.0%, python 10.9%, rust 0.3%. Rust's is near zero because a
    `trait` receiver is rare in this corpus, not because the guard is weaker —
    it reads the declaration keyword, where Python reads `Protocol`/`ABC` off a
    base list and TypeScript asks the compiler.

    **What this does not do:** nothing is licensed and nothing new may accuse.
    A closed share is a coverage figure. Wrongness for each resolver is
    `measure:resolution`'s (items 20-22), and no word's licence moved here.


24. **The population `@calls` was licensed on left out the receiver calls, and
    the reader's answers on them had never been read by anything. Six of its
    confirmations were calls to a standard-library method -- one of them a red
    on a correct board. 0 missed and 0 wrongly accused survive the wider
    population; the invented column did not (#254).**

    #211 reported 1,995 receiver calls apart from its recall figure and gave the
    right reason: its referee is a text scan, and a text scan cannot say whose
    `foo` is meant in `x.foo()`. What it also did was record that the reader
    "refused 1,245 of those and confirmed 622, and it should". The refusals were
    right. **Nothing had ever checked the 622.**

    **The second referee.** `scripts/lib/call-receivers.ts` asks the checker each
    language already has -- `tsc` in process, pyright and rust-analyzer over
    LSP -- for "go to definition" at the *call's own name*, which is the
    question the text scan structurally cannot put. It shares nothing with the
    reader: `callsBetween` places a name with tree-sitter and its own
    `Bindings`, and `resolves` never consults a resolver at all. Three outcomes
    per call, and the third is the one that keeps this honest:

    - **real** -- the checker names a line in the target file that declares the
      name. Scored exactly as a bare call is: agreed, refused, missed, accused.
    - **elsewhere** -- every site answered and none is the target, so the call
      is not to that routine and confirming it is an invention. It needs
      *every* site answered: one unplaced site could be the real call, and
      calling the rest elsewhere would turn a correct confirmation into a
      false accusation of the reader.
    - **silent** -- not scored, with the reason named. This is the line #211
      did not have: a call nothing can place is reported as such rather than
      dropped.

    **The numbers.** `npm run measure:calls -- --control --all`, 7 trees, 1,740
    files, 18m 12s. Run twice, on a corpus that gained files in between (two of
    the seven trees are this repository's own `src` and `scripts`, and #261 and
    #262 landed between the runs): **every figure in the table below is
    identical across both**, and what moved is the bare-call population it is
    measured beside -- ts 1,407 to 1,416 -- which is the unpinned corpus behaving
    as PR #238 already recorded it behaving, when the same effect moved a
    closed-body figure between two runs of identical code.

    | language | receiver calls | real | elsewhere | silent | agreed | refused | missed | accused | invented |
    |---|---|---|---|---|---|---|---|---|---|
    | python | 1,494 | 876 | 271 | 347 | 542 | 334 | 0 | 0 | 0 |
    | ts | 389 | 33 | 353 | 3 | 32 | 1 | 0 | 0 | 0 |
    | tsx | 74 | 1 | 73 | 0 | 1 | 0 | 0 | 0 | 0 |
    | rust | 161 | 45 | 24 | 92 | 17 | 28 | 0 | 0 | 0 |
    | js | 11 | 0 | 0 | 11 | 0 | 0 | 0 | 0 | 0 |

    And over the corpus Rust's own row is measured on (`.corpus/ripgrep`,
    `.corpus/anyhow`, `rust-test`, `~/orangutan`), 2m 08s: 2,221 receiver calls,
    1,381 real, 763 elsewhere, 77 silent -- 350 agreed, 1,031 refused, **0
    missed, 0 accused, 0 invented**.

    So the two columns a licence rests on hold on the harder half of the
    population: `MISSED` and `ACCUSED` are zero everywhere, over 4,350 receiver
    calls between the two corpora. The population the licence speaks for grows
    from 5,525 to 6,401 in Python and from 574 to 1,955 in Rust.

    **The cost is refusal, and it is large.** Of the receiver calls that are
    genuinely to the target, the reader confirms 61.9% in Python, 97.0% in ts
    and 25.3% in Rust's own corpus, `receiver` being nearly all of what it
    withholds. A refusal is silence on a board, so this buys the wider
    population without spending anything a person sees -- but it is why the
    headline recall falls when the calls are counted in (92.9% -> 88.7% Python,
    66.0% -> 37.3% Rust). **The recall figure is now over a population that
    includes the questions nobody could answer before, and it should be read
    that way rather than against #211's.**

    **The reader bug, which is the actual finding.** Six confirmations came back
    `elsewhere`, and every one was read against the source: `seen.add(file)` on
    a `Set` (`src/engine/rust.ts`), `await response.json()` on a fetch
    `Response` (`src/server/board-server.ts`), and in ripgrep
    `Read::read_to_end`, `Path::parent` and `Command::arg` twice. In each case
    the repository declares a routine of that name itself, and `resolves`
    matched on the name.

    Two lines, in the wrong order:

    ```
    if (!bindings.local.has(bound)) return callee.kind === "through" ? "receiver" : "unbound";
    if (side.file === target.file) return "yes";                       // asked first
    return callee.kind === "through" ? "receiver" : undefined;          // asked second
    ```

    A bare `add()` in a file that declares `add` is that file's own, which is
    what the same-file branch is for. `seen.add(x)` is a method on `seen`, and
    this file declaring an `add` says nothing about it. `placeOf` -- whose doc
    says "every branch below is the same branch in the same order" -- asks
    `through` first and is right. `resolves` asked it second, so a receiver call
    fell into the bare answer.

    **It reaches a board, and the cost is a red.** `drift.ts` puts both ends of
    a `@calls` arrow through `callsBetween` with no same-file guard, so two
    boxes anchored at one file are a real arrow. Forward, the bug is a
    confirmation nothing earned. Reverse -- forward genuinely absent, the bug
    firing on the other direction -- is `calls-backwards`: **"the code says this
    runs the other way, turn the arrow round", about a call to `Set.prototype.add`.**
    `tests/calls-claims.test.ts` builds that board on a real workspace and it
    goes red without the fix.

    Fixed by swapping the two lines. The absence axis cannot move with it:
    `resolves` is reached only from `callsTo`, and `callSitesIn` -- the whole
    closed-body path, items 13 and 14 -- uses `placeOf`, which was already
    right. Items 13's 50.3% and 14's 0.7% stand unchanged.

    **Two guards on the check itself**, because a corpus-scale agreement rate is
    not evidence on its own (#250's lesson, applied here):

    - **A negative control.** Every answer judged against a *different* call's
      target: 1 of 1,073 lands in ts, 0 of 2,905 in Python, 0 of 1,558 in Rust.
      The one is `guard`'s own signature line, `async function guard<T>(run: ()
      => Promise<T>): Promise<T | ReturnType<typeof failure>>`, which genuinely
      contains both the name asked about and the stranger's -- the honest limit
      of comparing by "does this line declare the name", and it can only ever
      turn an invention into an agreement, which is the direction that would
      have hidden this bug rather than manufactured it.
    - **A positive control** (`--control`): the checker asked the questions the
      text scan already answers. It agrees on 5,082 of 5,525 Python bare calls,
      1,398 of 1,416 ts, 518 of 558 Rust.

    **The positive control found something bigger than it was built for: 374 of
    Python's 391 refusals are the referee asking a question with no right
    answer.** `graphify` declares a `set` and a `patch` of its own, so the text
    scan credited every `set()` and `patch(...)` in the tree to them --
    `self._keys: set[str] = set()` is the builtin, and
    `with patch("shutil.which")` is `unittest.mock`. The reader withheld all 374
    and was right every time. Measured only over bare calls the checker says are
    real, Python reads **99.9% (5,075 of 5,082)** against the 92.9% on the
    record, ts **99.4%**, tsx **92.8%**. Item 9's warning about reading a zero
    has a twin: **a refusal rate is only a cost if the questions were fair**,
    and a third of Python's looked like a reader limit and were a referee bug.

    The reader confirmed **0** of the 404 bare calls the checker says are not
    real, across both corpora. That is a far stronger statement than the
    sentinel `zzNotARealRoutineName` the INVENTED column rests on: these are
    real calls to real routines somewhere else, and the reader took none of
    them.

    **What it costs to run.** 18m 12s for the default corpus against about
    3m 45s for the text scan alone, and `measure:calls` now carries
    `NODE_OPTIONS=--max-old-space-size=8192` the way `measure:closed-bodies`
    and `measure:resolution` already do -- one real `ts.Program` per package in
    a monorepo the size of `mundane` peaks well past Node's default.
    `--no-checker` runs the old measurement exactly, for a cheap re-read.

    **Two harness bugs, both found by running it.** `measure:calls` walked its
    trees with `find` through `execFileSync` inside a blanket `catch`, so
    `~/mundane` (126,863 files) and `~/infrarouter` threw `ENOBUFS` and read as
    empty -- **the report said 7 trees while it read 5**, and #211's own 6,654
    calls and 1,995 receiver calls cannot be reproduced from it. The walk is now
    `scripts/lib/source-files.ts`, pruning while it descends, the same shape
    `resolution-ts.ts` and `licence.ts` already use; eight other `measure-*`
    scripts still have the old one. And the one MISSED in the default corpus
    (`probeSource -> opening`) is the referee's error, not the reader's: two
    files declare an `opening`, the checker points at the local one, and the
    reader is right to disagree.


25. **The routine end of `@accesses` did not need a type checker, which is what
    #226 ordered it last for. It needed a name. About 2.5 million asks over the
    twelve pinned clones, 14 disputed and every one the referee's; the typed
    design the issue proposed was smaller and made false reds of its own
    (#255).**

    #226 put this last because "this routine does not read that field" seemed
    to need every receiver in the body typed: `x.rows` cannot be said not to
    read `Cache.rows` until `x` is known. True, and only of a body that contains
    `.rows`. A body whose every read has a `.name`, and none of whose reads is
    called `rows`, does not read `rows` off anything.

    **Both designs, measured over the same bodies.** `measure:accesses-closed`
    counts the typed region and `measure:accesses-absence` asks both.

    *By type* (region A: every read placed by the checker, no read without a
    name), over #255's local corpus of 31 trees: TypeScript 72.4% of named
    bodies that read anything, Python 51.1%, TSX 33.6%, Rust 29.6%. Two cuts
    followed before it could ask anything safely. A read the checker names
    without a declaring file cannot be matched to a box — `x.text` on a
    `Node | undefined` is a read of `Node` — and that was 42% of TypeScript's
    region. And #233's guard against a receiver typed as an interface left 202
    TypeScript bodies. Three ways a type answer made a false red, each found
    rather than supposed: `shadowNames(tree: Tree)` in `signature.ts` reads
    `tree.rootNode` off a local interface mirroring `parse.ts`'s tree, which at
    runtime *is* that tree; a read off `Partial<Config>`, `Readonly`, `Pick` or
    `Required` is placed in `lib.es5.d.ts`, confirmed on a probe project and not
    caught by the guard; and a union has no single declaration. TypeScript has
    no independent checker to measure placement against at all (#260).

    *By name*, over the same 31 trees and with no checker: TypeScript 74.3%
    (1,590 bodies), Python 65.0%, JavaScript 65.4%, Rust 49.3%, TSX 33.6%;
    105,226 asks, **1 disputed**. Over the twelve pinned clones:

    | language | region | asks | disputed |
    |---|---|---|---|
    | python | 75.7% (33,228) | 1,932,538 | 14 |
    | ts | 71.7% (7,333) | 293,709 | 0 |
    | tsx | 56.4% (1,467) | 164,956 | 0 |
    | rust | 66.1% (2,249) | 114,273 | 0 |
    | js | 76.4% (440) | 6,065 | 0 |

    **Every dispute was read.** By type, 44 across the corpus: one genuine false
    red (`shadowNames`), the rest the referee unable to say whose `.x` it saw —
    `evl.register(..)` inside a `fn register`, Web Audio's `osc.frequency`
    beside a `types.ts` that declares a `frequency`. By name, 15: all type
    annotations the text scan read as member reads, `typeof
    useDesktopStore.getState` and fourteen multi-line Python signatures.

    **What building the reader found**, each now a test:

    - Anonymous callbacks were counted as routines: 501 bodies no board can
      name, and every one of the bodies that would not pair with the call reader's.
    - `const draw = () => ..` had no name in the reader, and has one everywhere else.
    - `rows.sort(key=lambda r: ..)` was a routine called `key` — seven of the
      first eight by-name disputes.
    - A read in a parameter default, `reason = REASONS.none`, was invisible:
      11 routines in about 13,000, and an absence cannot rest on a blind spot
      however rare.
    - A Rust macro hides every read in its arguments: 23 of the first 24 reads
      the reader could not see, inside `log_line!`, `assert_eq!` and `json!`.
    - `getattr(c, k)` and `vars(c)` are `c[k]` spelled another way.
    - A field named `abstract` is valid TypeScript and stops tree-sitter parsing
      the file, which `engine-deps.test.ts` caught.

    **Helpers.** `draw()` calls `paint()`, which reads `width`. The right board
    is `draw --calls--> paint --accesses--> Config`, so a red on
    `draw --accesses--> Config` would be the right arrow drawn a level too high.
    The red stays quiet when a function the body calls *visibly* reads the
    member, followed one hop: placed by the call reader, or found with the "go
    to definition" #254 built for `measure:calls` and nothing else used. A call
    nobody could see into does not keep it quiet; the red says how many there
    were.

    On this repository's own TypeScript, with no checker, 85.2% of asks sat in
    a body with a call nobody could see into; with receiver types and the
    lookup, 19.9%, and 1,405 calls were proven to leave the repository. The
    quiet share barely moved, 4.1% to 4.4%: the lookup mostly proves a call goes
    somewhere no board draws rather than finding helpers, which is why the draw-
    time check in the MCP server, which has no checker, still sees nearly every
    helper.

    Across #255's 31 trees, with receiver types and the lookup (26 runs, one
    per `mundane` package, merged with `--merge`), of the asks where the body
    reads nothing called the member:

    | language | quiet: a helper reads it | red, past a call nobody could see into | red, every call seen |
    |---|---|---|---|
    | ts | 4.7% | 14.1% | 81.3% |
    | tsx | 7.7% | 10.6% | 81.7% |
    | python | 4.0% | 29.2% | 66.8% |
    | rust | 3.7% | 28.0% | 68.3% |
    | js | 1.9% | 86.8% | 11.4% |

    JavaScript's middle column is the checker, not the code: `checkJs` is off,
    so 133 of its 165 calls in these bodies got no answer. Python's is mostly
    pyright falling silent (768 calls) against 7,935 it settled as leaving the
    repository.

    Two numbers on the way here were wrong before they were right. The first
    helper figure, 88%, came from a run with the checkers switched off for
    speed and was quoted as a fact about the code. And the first version of the
    lookup read a call to a parameter — `isTest(file)` — as a call to the
    routine declaring it, because "go to definition" lands on the parameter;
    that counted a call nobody can see into as seen.

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

- **Reading an arrow with one end outside the repository** (#58). An arrow
  from code to a person, another product or a file on disk is dropped before
  any check reads it: every channel asks whether code A reaches code B, and
  there is no B. #58 weighed two ways of reading one anyway -- let a `via` route
  run with one end outside, or read an I/O verb in the prose against code that
  provably does no I/O -- and section B2 of `npm run measure:vocabulary` is why
  neither is built. **8 of 150 arrows** on checked boards take this path. **0**
  carry a route, and 1 of 313 arrows in the whole corpus does; **0** carry a
  claim word; 2 have no code at either end. The prose is eight phrases, two of
  them I/O verbs, and both of those arrows are true.

  So the route reading would read nothing, and the verb reading would read two
  correct arrows after paying for a no-I/O reader per language (nothing in
  `src/engine` reads I/O today), a referee, a licence, and a verb list -- the
  kind [reading-a-grammar.md](reading-a-grammar.md) is about, over prose that
  already spells "stores or sends" as `writes`, `saves`, `flushed → close`,
  `emits`, `tx.send` and `HTTP/1.1`. What was built instead is the admission:
  the board page's quiet line counts the arrows nobody read, and `--coverage`
  names them. **Reopen when** B2 reports tens of external-end arrows carrying
  I/O prose, not two.

  The other half of such a claim -- that it writes *that* file -- is out of
  reach either way. On the board that raised it the file is `create_diagram`'s
  path argument, a runtime value no reader follows (#203).

## A note on that orangutan arrow

`orangutan/docs/diagrams/route-registration.excalidraw` carries
`RouteInfo --[parameter @takes]--> hello_handler` and reports red. #188 tells
this as an authoring failure — somebody reaching for the nearest word and being
accused. **It is not: it is the owner's test that a false claim goes red.**

The red is correct and should stay. `@takes` is false there — `hello_handler`
takes a `&Request`. And `@holds` is not true either, because the far end is a
function rather than a type, which is now caught as a category error.

Worth knowing before reading #188's framing, and worth not "fixing".
