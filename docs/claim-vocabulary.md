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

## The ten words, and the three footings

Ten words, and they do not all refute the same way. This is the distinction
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
| `@handles` | handles | a routine's dispatch — the arms of a `match`, a `switch` | yes | **absence**, both ways |

The last one is on a **box** rather than an arrow, and it is the first box word
to reach this table. `@closed` is the other one and `@complete` is on the board;
both refute from absence too, and both read the imports, which is why neither
needs a row on [the grid](#the-grid) — see the note under it.

`@handles` refutes both ways and that is unusual enough to state: a case the
code dispatches on that the box does not list, *and* a case the box lists that
the routine has no arm for. Both are absences in a closed region — the arms of
a dispatch are enumerable from the text — so both can say wrong. The second one
withholds where the routine has a `_` or a `default`, because a fallback really
is handling the case and calling that wrong would be a false red.

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
  a function that visibly reads the member ([item 25](#forty-two-times-a-measurement-contradicted-the-design)).

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

**TS and TSX are separate columns**, and that is #206's doing. They agreed on
every word for eight words running, so one column said both — and the ninth
word is the first where they do not: TSX disagrees with the referee on 5 of 40
case labels where TypeScript disagrees on 7 of 1,099. A table that cannot say
so would have had to round one of them, and rounding *up* is the direction that
grants a licence nobody measured.

| word | TS | TSX | JavaScript | Rust | Python | what measured it |
|---|---|---|---|---|---|---|
| `@needs` | yes | yes | yes | yes | yes | a compiler, five pinned repositories per language |
| `@takes` | yes | yes | **no** | yes | yes | a text scan of the same signatures |
| `@returns` | yes | yes | **no** | yes | yes | the same run |
| `@holds` | yes | yes | **no** | yes | yes | a text scan of the same field lists |
| `@builds` | yes | yes | **no** | yes | **no** | a text scan of the same routine bodies |
| `@calls` | yes | yes | **no** | yes | yes | a text scan that bounds each routine and reads its calls |
| `@accesses` | yes | yes | **no** | yes | yes | a text scan of the same member lists |
| `@conforms` | yes | yes | **no** | **no** | yes | a text scan of the same declaration headers |
| `@handles` | yes | **no** | **no** | yes | **no** | a text scan that reads `case X:` and `X =>` with no grammar (Rust: a real `syn` parse, #267) |

`@feeds` is not on it. It never accuses, so there is nothing to license.

**`@handles` is the first box word on the grid, and `closed` is deliberately not
on it.** The rule is what a word *reads*: `closed` reads the imports, which is
`@needs`' reader measured by `@needs`' corpus, so it asks `licenceFor` about a
path — that question in the form it can put it. `handles` reads a dispatch,
which nothing else here reads, so a row of its own is the only thing standing
between it and accusing on somebody else's measurement. That is #195 exactly.

**Its row now has two `yes`es, and Rust — the square #206 predicted would be
strongest and #267 first found a stated no — is the second.** 1,042 Rust
dispatches and 2,959 case labels, the largest population of any language
here by a factor of three, and the reader disagreed with a line-based
referee on 3.55% of them. The reason was the *referee*: a line-based scan
cannot see an arm `rustfmt` broke across lines, it counts a `macro_rules!`
arm as a case, and every disagreement read one by one was one of those. Item
18 settled that this was not enough — agreement is not evidence once a check
is known not to discriminate — so the square stayed no until something that
could discriminate existed. `rustc`'s own non-exhaustive-match error was
priced first and is still blocked (`.corpus/ripgrep` needs rustc 1.96, this
machine has 1.93.0); a real parser (`syn`) was not blocked, and #267 built
one, found two bugs in the *reader* rather than the old referee along the
way, fixed them, and moved the square. Item 41 has the numbers.

TypeScript is **0 invented and 7 missed of 1,099** (0.64%), and all 7 are the
referee reading a `switch` written inside a template literal in a test fixture.
`covers` withholds TSX (5 of 40 labels disagree) and JavaScript (0 of 27
disagree, but 27 asks over 1,119 files is the thin evidence Rust's `@calls`
square was refused for) rather than letting either inherit the TypeScript row.

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

`measure:conforms` asked `@conforms` about JavaScript **0 times over 21 files**
when the square was filled in, and over the pinned clones it asks **5 times over
1,254** — the third square JavaScript has failed to earn for the same reason.
Python and TypeScript were measured at **0 accusations and 0 inventions across
2,652 asks**, and asked the same pairs backwards they confirmed **0** — which is
the number the word exists for, because before it an arrow drawn from the base
down to the subclass passed every check this tool had. Over the pinned clones
(#278, item 40) that is 15,194 asks: Python accuses none of 14,238, and all 32
TypeScript accusations are the referee reading a header written over several
lines. Asked backwards they confirm 5, and all 5 are two declarations of one
name in one file, each written both ways.

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

`measure:constructs` asks `@builds` about Python **0 times over 442 files**, and
0 times over the pinned clones' 4,077,
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
41 missed and 0 invented; 2,300 field asks over the pinned clones, whose 241
misses are all the referee's (item 40); 25,151 type names in 49,371 functions
with 0 missed; 5,525 calls in 683 files with 0 missed and 0 invented, refusing
7.1%. Four separate runs against four unrelated referees,
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

## What a claim needs from its end, and the end that has not got it

Everything above is about what an end *says* -- its fields, its signature, the
calls in its body. #297 is the question underneath: whether the end is the kind
of thing the claim is about at all.

`Client --@feeds--> handle_request` is the case it came from. `Client` is a
struct, and a struct has no result, so no reader was ever going to confirm that
arrow -- and each of them met it on its own terms, found nothing, and withheld.
The one mistake on that board a person could have fixed in a second reported as
"not sure", which is the same failure `an-end-is-data` names for an unclaimed
arrow, one layer up.

**What each claim needs from each end is written by hand, once, and it is the
only hand-written part.** Nine lines, in `NEEDS` in `parts.ts`:

| word | at the tail | at the head |
|---|---|---|
| `@needs` | nothing -- every declaration lives in a file, and a file has imports | nothing |
| `@feeds` | a result | — |
| `@calls` | a body of code that runs | — (calling a class is how Python constructs one) |
| `@builds` | a body of code that runs | a type |
| `@takes` | a type | parameters or a return type |
| `@returns` | a type | parameters or a return type |
| `@holds` | a field list | a type |
| `@conforms` | a base list | a type |
| `@accesses` | a body of code that runs | a field list |

The first cut had one column. #297 listed one end per word and that is what was
built; #301's test set plants its wrong-kind mistakes mostly on the other end
-- `@holds` *into* a function rather than *from* one -- and scored the first cut
at 7 of 146 of them. The second column is the same reading ("a declaration
with parameters is never a type") and was measured before it was switched on.

**Whether an end has that part is read from the grammar's fields**, which is
the whole point: a table of "a struct cannot feed" per language is the list
`docs/reading-a-grammar.md` was written about. Two shapes, both `parse.ts`'s
own rule:

```
a routine    a declaration with a `parameters` field
a container  a declaration with a `body` field and no `parameters`,
             `value`, `right` or `type`
```

A routine has a signature and a result, and never a field list or a base list.
A container is the other way round. Everything else -- a constant, a field, a
type alias, a variable holding who knows what, a name out of a macro -- is *not
sure*, and never lacks anything. A name declared twice lacks a part only when
every declaration of it does, so `interface Handler` beside `function Handler`
has a signature.

### The three refusals that keep it honest

**A confirmation always wins.** The question is asked once, after every reader
above has had its turn, so an arrow one of them confirmed never reaches it.
Python's `work(Config())` really does put a Config into `work`, and if
`feeds.ts` can see that, the arrow stays green whatever shape `Config` is.

**A container that holds code is not "no body".** A Python class body runs at
import, a TypeScript field initialiser runs at construction, and a module or a
class with methods holds routines somebody may well have drawn the box for. So
a container whose body contains anything invoked (`function`, `macro` or
`arguments` on a node) or any routine at all is read as *not sure*. What is
left saying "no body" is a field list and a class of nothing but attributes.
The cost is on the record below: 8,959 Python lacks and 1,621 TypeScript ones
given up.

**In Rust, no struct is ever said to have no code.** A Rust type's code is its
`impl` blocks, which live outside the declaration and may be in any file of the
crate -- the same footing as `@conforms` in Rust. That square was open for a
day, and the measurement agreed with it only because its referee had been told
the same wrong thing: a rust-analyzer `Struct` has no body. #301's test set
found it as two false reds (ripgrep's `GlobSet` and `Core`, both of which build
what the arrow says, in their `impl`). With the referee counting `impl` blocks
the square reads **1,068 wrong lacks**, and it is closed.

The lesson: a referee that shares the reader's definition is not independent
of it, however different its machinery. It took an answer key written from a
different definition to see it.

**A plan is never accused**, as with every other red here.

### The measurement

```
npm run measure:parts -- /Users/noelmatero/board-ai/.corpus/*
```

The referee is each language's own tooling and shares none of the reader's
machinery: rust-analyzer and pyright answering `textDocument/documentSymbol`,
and the TypeScript compiler's own syntax tree. Where a server will not classify
a line -- pyright lists one symbol per name per scope, so a `@property` getter
hides behind its setter and nothing declared inside a function is listed at
all; rust-analyzer answers nothing for a file in no crate and skips `fn gen`,
whose name is a keyword in the 2024 edition -- the line itself is read for the
keyword the language writes. That is a third mechanism, and it is in the
referee only.

| language | part | wrong lacks | unjudged | agreed lacks | missed | may accuse |
|---|---|---:|---:|---:|---:|---|
| rust | body | **1,068** | 283 | 51 | 1 | **no** |
| rust | signature / result | 0 | 0 | 1,817 | 797 | yes |
| rust | fields / bases / type | 0 | 0 | 10,264 | 308 | yes |
| python | body | 0 | 0 | 3,471 | 8,959 | yes |
| python | signature / result | 0 | 0 | 12,430 | 0 | yes |
| python | fields / bases / type | 0 | 0 | 42,222 | 0 | yes |
| ts | body | 0 | 0 | 1,966 | 1,621 | yes |
| ts | signature / result | 0 | 0 | 3,090 | 0 | yes |
| ts | fields / bases / type | 0 | 0 | 8,615 | 2 | yes |
| tsx | body | 0 | 0 | 71 | 59 | yes |
| tsx | signature / result | 0 | 0 | 120 | 0 | yes |
| tsx | fields / bases / type | 0 | 0 | 733 | 0 | yes |
| js | body | 0 | 0 | 3 | 12 | yes |
| js | signature / result | 0 | 0 | 15 | 0 | yes |
| js | fields / bases / type | 0 | 0 | 542 | 0 | yes |

17,955 Rust names, 100,346 Python, 49,146 TS, 10,258 TSX, 2,733 JS, over all
fifteen pinned repositories, in 2m53s. `missed` is the cheap direction -- the
tooling says "lacks" and the reader will not commit -- and it costs a red that
never fires.

The measurement was broken on purpose twice to check that it can fail. Made to
say a struct lacks fields, it refuses all five languages. Made to say a
function lacks a signature, it reports 926 wrong lacks in Python and 208 in
Rust. Neither control would have caught the Rust `body` square, because both
broke the reader and left the shared definition alone -- which is the case
above.

### What #301's test set says

`npm run bench:planted`, 855 planted and drawn mistakes and 428 true claims:

| | before #297 | first cut | with both ends, Rust body closed |
|---|---:|---:|---:|
| mistakes called wrong | 229 (27%) | 303 (35%) | **386 (45%)** |
| of which planted wrong-kind | 7 of 146 | 11 | **52** |
| true claims called wrong | 8 | 10 | **8** |

The 8 that remain are the same 8 as before any of this -- seven are the field
reader missing a TypeScript parameter property or a Python attribute set in
`__init__`, one is a clap import cycle -- and none is an end of the wrong kind.
The wrong-kind row does not reach 146 for two reasons on the record: `@calls`
into a constant is left alone by design (a constant may hold a function), and
Rust structs are never said to have no code.

What the licence costs when a square closes is one accusation and nothing else,
exactly as in `licence.ts`: the claim's own reader is untouched, and the arrow
goes back to being withheld.

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
| `npm run measure:handles` | can the dispatch reader be trusted with a red -- `--all` prints every disagreement |
| `npm run measure:holds` | can the field reader be trusted with a red — `--all` prints every miss |
| `npm run measure:calls` | can the call reader be trusted to say backwards, and how often it can answer — a real checker places the receiver calls its text scan cannot (#254); `--no-checker` for the text scan alone, `--control` to ask the checker the questions the scan already answers, `--dump=<file>` for every answer including the agreements |
| `npm run measure:constructs` | can the construction reader be trusted to say backwards — `--all` prints every miss |
| `npm run measure:signature` | the same for parameters and return types |
| `npm run measure:dataflow` | what following a value through one body buys, confirming and refuting |
| `npm run measure:recall -- .corpus/*` | when an arrow is true, how often its word says yes -- every word, per language, with ranked refusal reasons (#302); `--words=`, `--refuse-all` to switch every reader off, `--dump=<file>` for every unconfirmed ask |
| `npm run measure:licence` | reproduces the per-language dependency numbers, then prints the whole (word, language) grid — `--only=python` for one |
| `npx tsx scripts/probe-generative.mts` | draws boards of unseen code and counts what could not be said |
| `npm run bench:planted` | of the mistakes planted in 44 boards of the pinned clones, how many go red, how many show as not sure, how many pass silently -- and how many true claims go red (#296, `bench/README.md`) |

The last one is the only one whose answer key is not a second reader written
here: every claim in it was decided by rust-analyzer, pyright or the
TypeScript compiler, and a test fails if its three files ever import
`src/engine`.

The pattern in all of them is a **referee**: count the shape one way, count it
again by a completely different mechanism, report the disagreement. It is not
ceremony. Between them these scripts have found nineteen reader bugs and twenty-four
referee bugs, and not one was reachable by thinking about it. #206 alone found
seven and five, which is the largest haul from one word -- and the reason is
worth knowing: it is the first word whose reader had to work in five grammars
at once, so every place they disagree about a shape showed up as a number in
one column.

**A referee has a blind spot of its own, and `measure:calls` now has a second
referee for exactly that** (#254, item 24). Where a text scan cannot say whose
`foo` is meant in `x.foo()`, a real checker can be asked "go to definition" at
`foo` — and where the two referees can both answer, they agree.

### The corpus

With no arguments, code taken as it sits on disk rather than pinned: `src`,
`scripts`, `rust-test`, `~/orangutan`, `~/mundane`, `~/infrarouter`,
`graphify/graphify`. Four languages throughout, never one — a detector that
misses a language's spelling produces a confident wrong answer, which has
happened twice here.

**A licence row does not cite that default** (#278, item 40). It moves with every
commit to this repository, and four of the seven trees are other checkouts on
the machine that ran it, so a row quoting the bare command quotes a number
nobody can reproduce — the `holds`, `builds`, `conforms`, `takes` and `returns`
rows all did. They name `.corpus/*` instead: the fifteen clones `licence.ts` pins, which
live in the main checkout's `.corpus` (a worktree symlinks it). The Rust ones
are `ripgrep`, `anyhow`, `clap`, `regex` and `json`; the rest are
`owner-repo`.

Boards: the real ones, excluding worktree copies under `.claude` and test
fixtures. That is ~20 of the 1,902 `.excalidraw` files on the machine this was
written on; the rest are the same thirteen boards at six different ages.

## How often each word says yes (#302)

Every number above answers one question: **is it safe for this word to say
wrong?** A word that is perfectly safe and never confirms anything goes from
"not sure" to "not sure" forever, and no accusation count would show it. This
table answers the other question: **when the arrow is true, how often does the
word confirm it?**

```
npm run measure:recall -- .corpus/*      all fifteen pinned clones, ~26 minutes
```

**Unit:** one relationship that the word's own referee finds in the code. The
referee is the one its licence was measured with, now in `scripts/lib` so both
scripts share it. `@feeds` never accused, so it never had a referee, and
`feeds-scan.ts` is new. Both ends must be declared in the tree, and the far
end's name must be declared exactly once, which is `measure-calls`' rule. The
reader is asked with the arguments `drift.ts` passes it, including the far
end's file. **Recall = confirmed / asked.**

| word | python | ts | tsx | js | rust | all |
|---|---:|---:|---:|---:|---:|---:|
| `@needs` | 99.7% of 12,693 | 100.0% of 9,631 | 100.0% of 2,444 | 99.9% of 749 | 99.8% of 2,539 | 99.8% of 28,056 |
| `@takes` | 100.0% of 2,380 | 99.6% of 2,739 | 100.0% of 52 | — | 100.0% of 1,960 | 99.9% of 7,131 |
| `@returns` | 100.0% of 590 | 99.4% of 868 | 100.0% of 9 | — | 99.9% of 1,668 | 99.8% of 3,135 |
| `@holds` | 78.1% of 183 | 99.4% of 165 | 100.0% of 44 | — | 99.9% of 772 | 96.4% of 1,164 |
| `@builds` | 0.0% of 12,127 | 96.6% of 89 | 98.1% of 54 | 100.0% of 8 | 83.0% of 341 | 3.4% of 12,619 |
| `@calls` | 64.0% of 8,437 | 86.0% of 4,963 | 77.5% of 1,012 | 85.1% of 168 | 70.7% of 2,462 | 72.4% of 17,042 |
| `@accesses` | 99.0% of 24,536 | 91.3% of 1,053 | 83.1% of 468 | 81.6% of 87 | 67.8% of 3,758 | 94.5% of 29,902 |
| `@conforms` | 100.0% of 4,782 | 88.7% of 477 | 100.0% of 3 | — | 95.1% of 485 | 98.6% of 5,747 |
| `@feeds` | 100.0% of 140 | 96.6% of 417 | 100.0% of 48 | 100.0% of 12 | 68.8% of 16 | 97.0% of 633 |
| `@handles` | 33.3% of 6 | 37.6% of 133 | 16.7% of 12 | 20.0% of 5 | 71.5% of 1,131 | 67.1% of 1,287 |

**The three low figures have three different causes.** Each is labelled in the
script's `REASONS` table as "the reader cannot see it" or "the fact is not in
the file".

- **`@builds` in Python** is `call-shaped`: `constructs.ts` refuses the whole
  language before reading anything. The fact *is* in the file. The import that
  binds `Response` names the file declaring `class Response`, and `calls.ts`
  already follows it.
- **`@needs` was 75.7% and is 99.8%**, and the row above is the second run.
  It lost 19.8% to `dynamic`, 3.6% to `cycle` and 0.8% to `incomplete`, because
  `needs.ts` refused when **either** file did something at run time or had a
  parse error anywhere — even when the import it was asked about was written
  plainly in the tail. `flask/__init__.py -> app.py` was refused over a
  `table[name]()` elsewhere in `app.py`. **#308 split the two questions.**
  Finding the import confirms; only the accusation needs the whole file, and a
  cycle confirms both its arrows because both are true. What the gates cost,
  measured either side of the change on the same corpus:

  | reason | before | after |
  |---|---:|---:|
  | `dynamic` | 5,545 | 1 |
  | `said:cycle` | 1,005 | — |
  | `incomplete` | 235 | 1 |
  | `said:absent` | 37 | 37 |
  | `said:backwards` | 9 | 9 |

  **The bottom two rows are the ones to read.** They are the definite noes — the
  reader contradicting the referee — and neither moved, which is the check that
  the confirmations were bought with nothing. The 37 are mostly Django
  re-export chains. The 48 that remain are 0.2% of 28,056.
- **`@calls` in Python** is 64.0%, and **1,900 of its 2,100 `unbound` are the
  referee's**: calls to a built-in (`super` alone is 1,610) that the tree also
  declares once. With built-ins left out it is 83.6% (5,400 of 6,461), and
  Rust's is 72.2%. The rest of `unbound`, and `unplaced`, are genuinely not
  in the file: a pytest fixture, a browser global, a package path.

Two more that are not what they look like:

- **`@handles` at 67.1%** is mostly `several-dispatches` (251 Rust routines
  with more than one `match`). A box names one case set, and the reader will
  not guess which one.
- **Python `@accesses` at 99.0%** is partly agreement by construction. The
  population is "`.m` read in a routine, and one type in the tree declares
  `m`", and the routine end confirms by name (see #304).

Fact-not-in-the-file is small wherever it is measured: `region-is-the-crate`
is 0.2% of `@conforms`, `impl-elsewhere` and `open` are 1.5% and 1.2% of
`@accesses`, and `unplaced` is 2.1% of `@calls`.

**`said:` rows in the report are mostly referee mistakes.** In every case read
from `@calls said:refuted`, `@holds said:absent` and `@handles said:wrong`, the
text scan had misbounded a routine (`function CustomObject() {}` never closes)
or read a dict literal as fields. The recall figures are a floor.

**Broken on purpose:** `--refuse-all` switches every reader off, and every
cell falls to 0.0% over the same populations. `tests/measure-recall.test.ts`
keeps that true on a fixture.

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

## Forty-two times a measurement contradicted the design

Kept because the pattern is the point: eleven of the first thirteen came from
building one word or one reader, not from reviewing the design. Nothing since
has broken that — item 24 is the clearest case of it, a reader bug four
measurements had walked past because the population it lived in was reported
apart and never scored. Item 25 is the other kind: an issue's premise, that a
word needed a type checker, which measuring both designs over the same bodies
turned out to be wrong about. Item 26 is a third kind and the cheapest: an
issue's own evidence for a word, read one arrow at a time, turning out to be
evidence of something else.

Items 33 to 35 are a fourth kind, and the cheapest of all: not a reader bug and
not a design error, but a measurement that had quietly stopped reading most of
its corpus, so four numbers on an issue were shares of 15% of what they claimed.
Nothing failed. A lost tree lowers a number, and a lowered number reads as a
finding.

Items 26 to 28 are all one measurement's first run. `measure:reach` was built
to answer "how many steps can the engine follow", and before it answered that
it found two false-confirmation generators in the channel that was already
shipping and one cache that made an answer depend on which files had been read
before it.

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
duplicate from conflitcts, requires reading prs "An arrow can be three calls long #271" and "A box can say what cases a routine handles, and go red when the code grows one (#206)
#266 ·" to be read to resolve
26. **The body search was confirming arrows on a name that meant something
    else, 60 times in Rust and 8 in Python.** `anyhow`'s `chain.rs` declares `fn len`
    whose body writes `cause.source()`. An arrow from `context.rs#source` to
    `chain.rs#len` came back **confirmed** — the body writes the word `source`,
    and it is `StdError::source` on a trait object (#reach).

    This is the failure ee3b29e already names and fixed in one place only.
    Following a hop refuses `Type::foo` and `other.foo` because they are
    somebody else's `foo`; the place the search *stops* counted every
    identifier leaf, member halves included. Inside one file that is right —
    there is no second thing the name could mean. Across files there is, and
    every one of the 51 was that shape.

    The fix is the same rule at the terminal match: for a target in another
    file, a name written as somebody else's member is not evidence.
    `self.foo` and `this.foo` still count, because a Rust `impl` block for the
    routine's own type may be in the other file.

    A second, smaller version of the same thing was found in the same run.
    Flask writes a nested `def decorator` inside `app_template_filter`, so an
    arrow from `app.py#decorator` to `blueprints.py#app_template_filter` was
    confirmed on that body writing `decorator` — its own, declared eight lines
    down. That is Python's half, fixed by dropping from the question any
    name the searching file declares itself, which is `call-scan.ts`'s own
    rule: a referee that cannot tell which of two same-named things is meant
    has no business asking.

27. **A cache keyed by node id made the same board give two different
    answers.** `body.ts` held one node's token set in a `Map<number, ...>`,
    and a node id is an address inside one tree. Evict that tree — 48 is the
    parse cache limit — and the next one is handed the same addresses, so the
    cache answers about the new file with the old file's tokens (#reach).

    Not a slow cache: a wrong answer, and the worst shape of one. It depends
    on how many *other* files were read in between, so whether an arrow is
    confirmed is decided by what else happened to be on the board. It was
    found because the cross-file walk parses more files than the one-file
    search did, and one arrow in `measure:reach` moved with nothing about
    that arrow changed. Held against the tree in a `WeakMap` now, so the
    lifetimes agree by construction.

28. **The confirming search had a wall, not a budget, and `@calls` was saying
    "wrong" on the other side of it.** `body.ts` follows calls as deep as they
    go inside one file, which reads as a depth limit and is not: `bodiesFor`
    looks a callee up in the tree it already parsed, so a chain ends at the
    first file boundary. Most real chains cross one. Of 545 pairs two
    repositories' compilers say genuinely reach each other, the engine
    confirmed 232; it confirms 452 now, and 321 of the 406 that are two or
    more calls apart against 98 before (docs/reach-measurement.md) (#reach).

    The expensive half is what `@calls` did with the rest. Its closed-body
    absence (#233) is about the *direct* call and correct about it — and 58 of
    those 545 reaching pairs came back `refuted` and one `backwards`, so 59
    red accusations landed on arrows whose code really does reach. That is not
    a reader bug; it is a true verdict about calling being read as a verdict
    about the diagram. It is now an advisory that names the route
    (`calls-one-level-up`), on the same reading `@accesses` already gives the
    same shape: a board drawn one level too high is a board somebody can keep.

29. **One import specifier can resolve to two files, and the wrong one was
    winning on a tie-break.** Rust records `crate::codec::encode` against both
    the file declaring `mod codec` and `codec.rs` itself. `comesToRest` ends
    with a permissive step -- a file that neither declares the name nor
    forwards it is still counted as the resting place -- which is right for a
    specifier somebody wrote down and wrong as a way of choosing between
    candidates. Taken in declared order `main.rs` won, and `encode` was placed
    in a file that declares no `encode` at all (#reach).

    Invisible while nothing walked past the first hop: `@calls` compares the
    placement against one named far end, and a wrong file simply fails to
    match, which reads as silence. The cross-file walk steps *into* the file it
    was given, finds nothing of that name there and stops -- so a three-file
    Rust crate's `main -> encode` could not be confirmed by any route.
    Candidates are now asked the strict question first (does this file declare
    the name, or forward it somewhere that does) and the permissive answer is
    the fallback. A single candidate, which is every TypeScript and Python
    import in the corpus, is unaffected either way.

30. **A minute of a Rust board's check was a timer nobody was waiting on.**
    Wiring rust-analyzer into the live check took `rust-test` from 1.3
    seconds to 61, which read as the price of a language server and was not
    (#reach). Instrumented: three seconds of server, 66 milliseconds of
    walking, 11 bodies read -- and 57 seconds of a process declining to end.

    Both language-server clients register `setTimeout` guards and never clear
    them. A request that answered leaves its 30-second timeout in the queue;
    `whenPrimed` leaves a 60-second one. Node will not exit while either is
    pending. Invisible until now because every previous caller was a
    measurement script ending in an explicit `process.exit`, which walks past
    a pending timer; `check-drift.mjs` ends on its own. `unref` on both, and
    the board went to 4.5 seconds.

    Worth keeping for the shape of it: the number looked exactly like the cost
    of the thing just added, and the thing just added was responsible for
    three seconds of it. A timing that matches your expectation is not
    evidence of what you think caused it.

    A second thing the same wiring broke, and the built bin is what found it:
    `vscode-jsonrpc` is a **devDependency**, so a static import of the Rust
    client put it in `out/cli/drift.mjs`, which is shipped, and
    `diagramos drift --help` exited 1 with `Cannot find module
    'vscode-jsonrpc/node'` on a tree where npm had never installed it.
    `packaged-server.test.ts` spawns that bin, which is why the suite caught
    what every unit test passed straight through. The transport is fetched
    when a server is started now, and failing to fetch it is the same silence
    as rust-analyzer not being installed.

31. **The next step this document named was not worth building, and the
    measurement said so before anybody did.** #reach's own "still out of
    reach" section named a cross-file field-type lookup as the thing that
    would raise the floor, on the strength of `self.inner.by_ref()` in
    `anyhow` being the shape a reader could not type. Counted instead of
    assumed: `no-fields` is **45 of ripgrep's 6,823** withheld receiver sites,
    11 of anyhow's 203, 109 of httpx's 2,577. What withholds is `not-a-name`
    -- 4,040 in ripgrep, an expression receiver no reader of text can type --
    and `imported-type`, mostly a module receiver `calls.ts` places anyway.

    The second half is worse for the proposal and more useful. `never reaches`
    needs a **closed** region, and closure is conjunctive, so the histogram of
    first doubts everyone had been reading says nothing about what a new
    reader would buy. Counted by the whole doubt set: 420 of anyhow's 965
    refusals are blocked by a `macro` among others, which no grammar parses;
    0 of Python's sample are blocked by one kind of doubt at all; and
    TypeScript's 84 receiver-only refusals are ones `tsc` already settles in
    the product, invisible here only because the answer key *is* `tsc`.

    So the only honest route to licensing that word is an independent referee
    for a compiler-backed reader -- pyright read, mypy refereeing, Python
    only. Worth keeping because the proposal was this document's own, written
    two commits earlier, and it took one afternoon's counting to retire.

32. **Three bugs in the benchmark's own negative population, and the one that
    mattered had been throwing away half of it.** `measure:reach`'s `never`
    asks are the only evidence that verdict could ever be licensed on, so the
    population is an argument and it was wrong in three ways (#reach).

    The callback guard asks whether a closure might hand the tail out as a
    value, and answered yes because the tail's own `export function` line was
    in a file the closure touches -- `ast.ts#createInterpolation` against
    `ast.ts#convertToBlock`, where the caller writes `isString` and nothing
    else. **348 of `vuejs-core`'s never-pairs rejected for no evidence at
    all.** The referee was directional where `checkSymbolEdge` is
    bidirectional by documented design, so a pair whose *tail* calls the head
    scored as a wrong confirmation -- 15 of them, all true statements about
    the wrong question. And one per-seed cap served both populations, so
    `--unguarded` moved the scored `never` count from 24 to 8: an instrument
    changing its own reading.

    What the corrected population then showed is the useful half. Wrong
    confirmations are **7 on TypeScript, 43 on Python, 26 on Rust, and every
    single one is same-file** -- cross-file is zero in all three, so the
    strict standard item 26 added is doing exactly its job. The remainder is
    the same-file lenient standard `body.ts` calls deliberate, and the corpus
    disagrees with its reasoning: `error.rs#deref` confirms against
    `error.rs#is` because the body writes `.is::<E>()`. Applying the strict
    rule inside a file was measured, not argued -- free on TypeScript, and on
    Rust 7 fewer wrong for 27 fewer right -- and left alone on that number.

    Read the agreements too, applied to the instrument rather than the reader.

    A fourth, in the suite rather than the measurement, and the shape is worth
    the line: `resolveRustDefinitions` got its own test file, which made three
    files each spawning their own rust-analyzer while vitest ran them in
    parallel. Whichever lost the race went red with `expected undefined to be
    defined` -- a starved server, reading exactly like a code fault, and
    alternating between files run to run. Folded into
    `resolution-rust-receivers.test.ts`, which puts the count back to the two
    it was.

33. **`measure:dataflow` had silently lost two of its seven trees, and the
    corpus it reports is the working tree it runs in.** Every number on #203 --
    19.3% of values contained, 1.4% for crossing a call, 0 leaked -- is a share
    of whatever the script managed to open, and for four days it opened 227
    files while saying it had read the corpus (#203).

    It listed each tree with `find` and filtered afterwards, so an installed
    `node_modules` was listed in full before being thrown away. `~/mundane`
    produces 16.9 MB of paths and `~/infrarouter` 1.5 MB, both past
    `execFileSync`'s 1 MB default, and a blanket `catch` read the `ENOBUFS` as
    "no files here". Both of those trees had `npm install` run in them at
    **21:55 on 2026-09-07**, hours after the run the issue body quotes -- so the
    corpus fell from 1,457 files to 227 and nothing anywhere said so. This is
    #254's bug in a second script; `scripts/lib/source-files.ts` is the walk
    written to fix it and this one had never adopted it.

    Restored, the figures reproduce: **1,500 files, 15,244 bodies, 19.3%
    contained-and-used, 5.6% confirmation gain, 1.4% across a call, 0 leaked and
    0 invented.** So the bar #203 reports as failed is **met on current main**,
    and the `1 leaked` at `scripts/measure-licence.mts:243` is not reproducible:
    today's reader calls that value `captured-by-a-closure`, and so does the
    reader from before #227, against both the current and the pre-#231 version
    of that file.

    Two things worth keeping from it. A measurement whose corpus is
    `path.resolve("src")` **measures the branch it is run on** -- adding one file
    to `scripts/` moved five of this report's rows, which is the corpus bias to
    name before quoting any of them. And a lost tree does not fail anything: it
    lowers a number, and a lowered number reads as a finding.

    **The sweep, and a correction to this item's own first count.** It first said
    seven more scripts had the bug, from a grep for `execFileSync("find"`. That
    grep was wrong twice over: in `measure-accesses` it matched the **doc comment
    describing the fix**, which that script already carries as its own
    `readdirSync` walk; and `measure-handles` passes `maxBuffer: 512 MB` and
    prints the tree it could not read instead of swallowing it, so neither was
    silently losing anything. `scripts/lib/boards.ts` lists `*.excalidraw` with
    `find -name`, whose output is tiny, and it deliberately reads *inside*
    `.claude` worktrees -- which the shared walk skips -- so adopting it there
    would break that on purpose. Left alone, and the reason recorded.

    Five were real and are now fixed: `measure:constructs`, `conforms`, `holds`,
    `signature`, `vocabulary`. Measured directly, the walk they shared read
    **230 of 1,506 files -- it lost 84.7%** -- and `constructs`, `conforms` and
    `holds` each printed "7 trees, 230 files" while saying so. `signature` was
    the one exception worth noting: it reads only `src`, `scripts`, two
    `rust-test` subdirectories and `graphify`, none big enough to overflow, so it
    was losing nothing today and was fixed for the trap rather than the damage.

    One more way the same walk loses a tree, which only bites in the worktree
    workflow this repository uses: `rust-test` is untracked, so a worktree
    symlinks it, and `find <symlink> -type f` without `-L` returns nothing.
    `statSync` follows it. That is 8 Rust files, and Rust is the language this
    corpus has least of.

    What the five had been hiding, now that they read their own corpus:

    | | before | after |
    |---|---|---|
    | `constructs` routines the referee could read | 1,500 | **3,282** |
    | `conforms` declarations naming something they are one of | 33 | **2,766** |
    | `holds` type declarations the referee could read | 332 | **4,309** |

    `conforms` is the one to look at twice. Its whole measurement rested on 33
    declarations and there are 2,766 -- so nothing that was ever said about that
    reader was said about its corpus. `vocabulary` has no source-side headline
    to move (its corpus is boards, through `boards.ts`); its source walk feeds
    only the staleness check, which stays at 0. And `signature` came out three
    files *smaller*: `src/engine/vendor/{browser-shim,entry,browser-entry}.ts`
    are first-party source in a directory named `vendor`, which the shared walk
    skips and every other measurement already did. Consistent now, and a
    reduction, which is worth saying rather than glossing.

    Guarded at `tests/measure-corpus-walk.test.ts`, and the rule is the narrow
    one: a script whose corpus names a big tree may not list it with `find`.
    `find` itself is not the bug. The test was checked by breaking a script and
    watching it name it.

34. **The 1.4% for crossing a call survives being re-checked against the real
    call graph, and it was never a share of the whole question.**
    `npm run measure:dataflow-reach` puts `callSitesIn` with `reach.ts`'s own
    receiver resolver beside the name resolver section 3 uses -- imported from
    the same module rather than reimplemented -- over 1,151 files and 13,756
    routine bodies (#203, #271).

    Of the 20,209 recorded sites the name resolver refuses, reach places the
    name on 2,866 and **402 of those have one routine of that name to read**
    (2.0%). 402 more resolvable sites against the 3,716 the report already
    resolves cannot move 1.4% materially, so **#203's ordering conclusion
    stands, and now against a real interprocedural walk rather than against
    `calls.ts`.** The gap between 2,866 and 402 was this measurement's own first
    answer and it was wrong: `callSitesIn` places the file a *name* is bound in,
    which for a local holding a function is the calling file --
    `convert.ts:37` calls `getConverter`, bound from a dynamic `import()` of the
    vendor bundle, and the site places to `convert.ts` where no such routine is
    declared. Placing a name is not having a body to read.

    All 402 are refutation-safe, and that is the part that could have gone
    wrong. Reach places a method call by reading the receiver's type out of the
    text, and `blocking()` makes any receiver site whose type is not known to be
    a *concrete* class a doubt -- so `never` is withheld on it even though the
    hop is still followed. The escape analysis is a refutation. Spending reach's
    extra placements on it would have bought the number back with exactly the
    move `reach.ts` refuses to make, and only a real checker clears that bar.

    **What the re-check actually found is that the 1.4% is a share of the bare
    calls only.** `calleeName` answers for a bare name and for `self.foo()` /
    `this.foo()`, and `body.calls` is appended to `if (callee)` -- so
    `store.keep(v)` makes `v` escape `passed-to-a-call` and writes no call site
    at all. `callee-is-a-method` is a member of the `Unresolved` union the report
    has never once printed, because the site never arrives to be refused.
    **4,191 of 9,257 values with a call-shaped exit (45.3%) were never in the
    question**, in the numerator or the denominator: ts 39.9%, tsx 47.3%, python
    47.3%, js 58.4%, rust 10 of 12. That is not resolver headroom and no call
    graph reaches it -- recording the site is a change to `dataflow.ts`, and the
    escape is recorded either way so the gap has always cost coverage rather
    than bought a false `contained`.

    What the check itself could not see: 5,662 of 30,883 recorded sites (18.3%)
    found no matching placed site, because the two readers name a routine
    differently -- **and on `tsx` that is 3,270 of 4,888, so two thirds of that
    language is uncompared.** Python is nearly fully compared (3 of 16,753).

35. **The first slice of the door question is buildable in TypeScript and blind
    in Python, which is the language that has the referee.**
    `npm run measure:door-values` asks the one thing that has to be true before
    "does this value reach a door?" can be built on this reader: is the door a
    call the reader wrote a site for? (#203, #270.)

    Of 390 doors written inside a routine, **240 have a call site (61.5%) -- and
    the split by language is the finding**: ts 206 of 239 (86.2%), js 18 of 19,
    **python 16 of 127 (12.6%)**, tsx 0 of 4, rust 0 of 1. It is the import
    style and not the language: `writeFileSync(body)` off a named import is a
    bare call and records, `fs.writeFileSync(path, body)` off a namespace does
    not, and Python spells almost every door `os.replace`, `shutil.rmtree`,
    `subprocess.run`. Verified at both ends -- the corpus tally and a unit test
    on the six shapes (`tests/dataflow-call-sites.test.ts`).

    **Those figures are the state before item 36.** Recording the site for a
    call on a receiver took the recorded share to 370 of 390 and Python to 127
    of 127; the reasoning below is what that step was chosen for, and it stands.

    So the value-level door question **must not be built refuting first**, and
    the reason is sharper than the general one. 87.4% of Python's doors are
    invisible to the reader, so "this value never reaches a door" would answer
    *never* for a value handed straight out through `os.replace(body, path)` --
    a false red on the exact shape the question exists to catch, in the only
    language with a run-time referee (`scripts/lib/reach_trace.py`). #273 is
    already open because "never reaches" rests on two Python repositories; this
    would rest on the language the reader reads worst.

    **Confirming is the slice that is safe and it is the one to build**: a value
    created here, followed through the locals and collections already modelled,
    reaching a call `outside.ts` names as a door. A missed door costs silence,
    which is what this engine accepts everywhere. Recording a site for a
    qualified call is the prerequisite and is worth doing for its own sake --
    it is the same 45.3% in item 34 -- and it cannot manufacture containment,
    because a name like `replace` resolves to nothing this corpus holds and the
    value goes on escaping.

    Two alternatives were weighed and are written down rather than tried.
    **Refuting the door question** is above. **A bigger call graph** is item 34:
    402 sites of 20,209 refusals. What is *not* rejected and is simply not this
    step is modelling what a library call does to what you hand it, which is
    where two thirds of the remaining escaping lives.

36. **Recording the call site nobody had written down made
    `callee-is-a-method` the biggest reason a value is trapped, and took seven
    false `contained` with it.** The narrow step chosen at item 35, built (#203).

    `body.calls` was appended to `if (callee)`, and `calleeName` answers for a
    bare name and for `self.foo()` / `this.foo()`. So `store.keep(v)` and
    `os.replace(v, p)` were exits with **no site at all**. The site is now
    recorded with an **empty callee** -- one line, and it reaches a branch
    `settleCalls` and `keeps` have carried since they were written and could
    never enter.

    Both halves of that are load-bearing. Recording the site counts the
    population: `callee-is-a-method` goes from never printed to **2,734, 49.5%**
    of the calls that still trap a value, ahead of `callee-not-resolved`'s 33.2%.
    Refusing to *name* it is what keeps it safe -- a resolver keyed on `write`
    finds any local routine spelled that way, reads the wrong body, and is then
    entitled to free a value that did leave. There is no name here to look up,
    so the site can only ever refuse.

    **And it was not only bookkeeping.** A value handed to a resolvable call
    *and* to an unnamed one was being freed on the strength of the one that was
    recorded. `contained`-and-used went 5,268 -> 5,261 and the headline 19.3% ->
    **19.2%**; `freed` went 370 -> 363, 1.4% -> **1.3%**. Seven values had been
    called "provably never left this body" while going out on the next line.
    Reproduced as a unit test first, and A/B'd against the previous reader:
    `freed=1 contained=true` before, `freed=0` after.

    **None of the seven was ever a `LEAKED`.** Because the reader set
    `freedByCall`, `measure-dataflow.mts` files those disagreements under
    "having read another routine's body", the population it declares
    unrefereeable *by construction* -- so a referee that could see them was told
    not to count them. Of the seven, three were sitting in an unrefereed bucket
    (135 -> 133 there, 216 -> 215 in the collection one) and the referee had no
    opinion at all about the other four. This is item 24's lesson in a second
    reader: a population reported apart is where the bugs are. The bar itself
    still reads 0 leaked, 0 invented.

    What it bought item 35 is the point of having done it. Doors with a call
    site go from 240 of 390 to **370 of 390 (94.9%)**, and **Python from 16 of
    127 to 127 of 127** -- because the door question never needed the name.
    `outside.ts` knows `os.replace` is a door from the *import*. What was
    missing was somewhere to watch, not something to resolve.

    Still unwatched: `tsx` 0 of 4 and `rust` 0 of 1, both too small to read
    anything from. And the handle shape -- `f.write(row)`, where `f` came back
    from `open()` -- is not in this population at all, because `outside.ts` does
    not call it a door: it reads as a method on a value rather than a module.
    Knowing `f` is a file needs a type, which is the tier-2 question.

    **One prediction in this work was wrong and the residual is a second
    limit.** `measure:dataflow-reach` was written expecting its "no site" column
    to fall to about zero once the sites were recorded. It fell from 4,191 to
    **1,147** and stopped, and reading the cases rather than the total says why:
    they are a **spread**. `emit(...read)` records the call and `args=[-]`,
    because `...read` may arrive as no parameters, one or many -- and which
    position a value came in at is exactly what makes a call resolvable. Where
    the spread goes into a modelled collection, `names.push(...read)`, there is
    no site at all, because that branch is the collection write and returns
    before one is made. That is undecidable rather than unwritten, so it is
    named and not fixed. 3,528 values now refuse by name; 1,147 cannot be
    attributed to a position at all.

37. **The door question was built, met its bar, and the number says do not
    ship it: seven flows in the corpus mean what it asked.** `outflow.ts` and
    `npm run measure:outflow` (#203, #270).

    The reader is the confirming half of #203's own question -- *this value is
    created here; does it reach something that writes it to a file, sends it
    over the network, or hands it to another process?* Almost no new machinery:
    `dataflow.ts` already follows a value through a body's locals and already
    records, at every call site, which producers reached it and through which
    locals; `outside.ts` already knows which calls are doors. It joins them and
    adds one rule of its own, the collection one.

    **The bar is `invented`, not `missed`,** because confirming is all it does:
    a door it cannot see costs silence, which the engine accepts everywhere. A
    text scan sharing no parse, tree or index asks the decisive question -- is
    the name handed over actually written in the door call's argument list?
    **309 flows, 309 corroborated, 0 invented. 24 of 24 hops walked. Two runs
    byte-identical.**

    **And then the split that undoes the headline.** `writeFile(path, contents)`
    takes a place and a payload, and "this value is written to a file" means the
    payload. Split by a `PAYLOAD_AT` table -- library knowledge, per door, which
    no rule derives -- **13 of 309 flows (4.2%) are the value that leaves**:

    | | flows |
    |---|---|
    | `execFileSync`, `spawnSync`, `subprocess.run` — an argument list to a process | **11** |
    | `writeFile`, `writeFileSync` — contents to a file | **2** |
    | the door carries nothing out (a read, a stat, a delete, a copy of paths) | 261 |
    | a payload door, but this value is the place or an option | 30 |
    | a payload door, position not recorded | 5 |

    Reading those last 5 by hand rather than shrugging: two are payloads nested
    one level deeper than this reader follows --
    `writeFileSync(p, Buffer.from(png))` and
    `writeFileSync(p, probeSource(readFileSync(f), list))` -- and three are a
    path inside `path.join(..)`. **So call it 15 of 309**, and the remaining gap
    is nesting depth inside the payload argument.

    **Fifteen flows in 1,500 files mean what the question asked, and eleven are
    one idiom** -- a `git(args)` / `run(args)` wrapper. Two are a file write.
    That is not a word, and it is the same shape as every other step on this
    issue: each move outward bought less than the one before.

    **That figure moved from 7 to 13 under challenge, and how is the useful
    part.** The first reading split it as "argument 0 is a path, argument 1 is
    the data" and found 7. Both halves were wrong. An inline call had **no
    recorded position**, so `writeFile(path, serializeBoard(board))` -- the
    commonest payload shape there is -- landed in "unknown"; and "argument 0 is
    a path" is false at `subprocess.run(args)`, whose payload *is* argument 0.
    Recording the inline position and writing the table moved it to 13. The
    conclusion held; the ground under it changed from an eyeballed number with a
    known gap to a measured one. It should not have been quoted before the gap
    was closed.

    Two more numbers in the same direction. **`out-of-a-collection` fires 0
    times** -- the rule written for this issue's own motivating example,
    `v.push(widget); use(v[i])`, pointed at a door, matches nothing in the
    corpus. And 141 values escape `into-a-structure` in the very bodies where a
    flow was found: `fetch(url, { body: payload })` is the usual spelling of the
    commonest door in TypeScript and `dataflow.ts` does not model a structure
    the way it models a collection, so the network row (18) is a floor and a low
    one.

    **Two reader bugs the referee and the examples found, in that order.** The
    referee first reported 3 invented and was wrong all three times:
    `subprocess.run(` opens on the door's line with `cli_args` on the next, and
    the scan read one line. Reading the argument list to its balancing paren
    fixed it -- the referee wrong more often than the reader, again. Then the
    *examples* found the real one: doors were keyed by **line**, so in
    `readFileSync(path.join(root, file), "utf8")` the arguments of `path.join`
    were attributed to the door, and `file` was reported arriving at
    `readFileSync` position 1 -- which is `join`'s position, and `readFileSync`
    has no second value argument. The flow was true and the path was not.
    Matching the door's own call site dropped 384 flows to 309 and is why the
    position split can be quoted at all. Neither would have been found from the
    totals.

    **Not shipped, and this is the recommendation not to.** Nothing reads
    `outflow.ts` but its measurement; no colour, no word.

    **The reason is the 15, and it is not demand.** Worth being exact, because
    the demand argument is not available here and was reached for anyway in this
    issue's own history. **The board corpus cannot answer whether anybody wants
    a word.** Those diagrams are the owner's own test boards, most drawn before
    `@feeds` existed, and none redrawn since -- so "one `@feeds` arrow across 21
    boards" is a fact about when they were made, which `measure:dataflow`'s
    section 1 says in as many words and which two comments on this issue then
    quoted as though it were demand. It is not evidence of anything about the
    word. Do not use it.

    What stands on its own is the capability: fifteen findings in 1,506 files,
    eleven of them one idiom. **Reopen when** a structure abstraction lands --
    `fetch(url, { body })` is the commonest door in TypeScript and is invisible,
    so the network row is a floor -- or when the payload count is large enough
    to be worth a word on its own terms.

38. **An arrow onto a file or a service can be checked, and what it took was
    letting an external box carry a door.** #272, built. The first thing in this
    programme that changes what a board says rather than what a measurement
    prints.

    Every arrow touching an `external` box was skipped before it: there is no
    code at the far end, so no channel had anything to compare, and the board
    said "4 more arrows were never read" and stopped. On
    `docs/diagrams/example.excalidraw` that is **4 of 6 arrows**.

    What is in the repository is the code that talks to the outside thing -- its
    **door**, which `outside.ts` finds (#270, wrong at most once per language).
    So an external box may now carry an ordinary `path#symbol` ref pointing at
    that routine, and the arrow becomes a question about code again: does the
    near end reach the door? Every channel already answers that. `drift.ts` had
    the skip *before* refs were looked at; now it skips only an unanchored box.

    **A ref is not enough, and that is the part that took the care.** An external
    box has always been allowed a ref that merely records what it corresponds to
    -- "Browser" against `src/b.ts` -- and two tests have encoded since `state`
    shipped that such a box is still skipped. Reading those as door anchors would
    change what boards already on disk mean and could confirm an arrow off one.
    So the anchor is **verified**: the ref names a symbol, and that routine
    really does call the file system, the network or another process. Both old
    tests pass untouched, because their refs are not doors.

    Confirm-only throughout. No route found is silence, on the footing every
    confirming channel here already stands on -- the refuting channels rest on a
    closed region and a door is not one.

    **A suggestion was built alongside it and removed, measured on a real
    board.** It named the one routine in the code end's file that touches the
    outside world, so an author could anchor a box in one edit. Run against
    `example.excalidraw` it offered `src/mcp/server.ts#steerExistingBoard` for
    the box standing for `board.excalidraw` -- and that routine's door is
    `fetch`, the **network**. The file's real door is `board-file.ts#writeBoard`,
    in a module the suggestion never looked at. A network door for a file box, on
    three of that board's four arrows.

    Which outside thing a box stands for is the author's statement. A checker
    that guesses it is inventing the claim it then checks, and an author who took
    the suggestion would have got a confirmation resting on the wrong code. So
    anchoring stays the author's job and the checker only verifies an anchor once
    it is there. The reasoning is kept in `drift.ts` where the code was, because
    the next person to want that convenience should see the number first.

    **What it does not do.** Nothing anchors a box automatically, so no board on
    disk changes behaviour until someone adds a ref -- `example.excalidraw` still
    reports its 4 unread arrows and still comes back clean. The value-level
    reader from item 37 is not wired in: this is the routine-level question,
    which is the one with the coverage.

26. **#206's demand number came back at 7 arrows of 162 and did not decide the
    issue, because the corpus it counts was drawn to test the tool. Built
    anyway, on the code-side argument the issue itself made. Licensed in
    TypeScript at 0 invented and 7 missed of 1,099 case labels -- and Rust, the
    square the issue predicted would be strongest, is a stated no.**

    `@handles` says what cases a routine dispatches on: `handles: ["Get",
    "Post", "Delete"]` on a box whose ref names a routine. It is the only word
    here that catches something being **added** to the code rather than
    something going stale, which is the one kind of drift nothing notices --
    adding a fourth case breaks no test and reads as progress.

    **The demand number, and why it did not settle anything.** `bucketOf` in
    `measure-vocabulary.mts` grew a `handles` bucket -- last in `BUCKETS` and
    claiming `dispatches on` rather than `dispatch`, so it cannot take arrows
    off `invokes`, whose count has been on the record since #187. It catches **7
    of the 162 arrows that carry prose**, the caption share moving 78.4% to
    74.1%, and read one at a time none of the seven asserts a case set: two are
    the pattern being too wide (`re-arm`, `arm writable` are epoll
    re-registration), three are a single arm drawn as one arrow, and `covers` is
    test coverage on an arrow that already carries `@needs`.

    That was written up as a closure and the owner rejected it, correctly. The
    census reads *prose*, so a drawing date cannot hide the demand -- but a
    *corpus* can, and this one is twenty boards of two codebases drawn to
    exercise the tool. "Nobody asked" is a fact about why those boards exist.
    The issue's own case was never the boards: it was a closed region going
    unused and a real failure nothing catches, and the closure leaned on the
    weakest evidence available. **The lesson is the one `AGENTS.md` already
    states one step earlier: name the mechanism that would have made the number
    different. Here the mechanism is who drew the sample and why.**

    **Arrow form versus box form, which #206 left open.** The box form, and the
    7 arrows are the argument for it rather than against: every one of them is a
    single arm drawn as one arrow, and an arrow can only ever say *this case
    goes there*. Only a box says *these are all of them*, and only that catches
    a forgotten branch.

    **One reader, five languages, and the only list in it is which node is a
    dispatch.** Two regexes for five languages; everything else is a field read
    or a structural rule -- the subject is the first named child before the
    body, a case's label is its first named child unless that child is the
    case's own consequence, an alternation is a label with an anonymous `|`, a
    catch-all is a case with no label or a label whose text is `_`. It is a list
    rather than a shape rule because the obvious rule -- a `body` field and no
    `name` field -- also matches every loop in all five grammars, and Python's
    `match` body is a plain `block` exactly like a `for` body. So it is tested
    for completeness rather than contents, per `reading-a-grammar.md`.

    **Seven reader bugs, and every one came from running it rather than
    reasoning about it.** Four from the sixteen-tree run, three from the
    measurement.

    - **`value` means opposite things.** It is the label on a TypeScript
      `switch_case` and the arm's *result* on a Rust `match_arm`, so the one
      field name that looks generic is the one that cannot be trusted. Nothing
      reads it.
    - **Counting loose children to find an alternation** is true of Rust's
      `or_pattern`, Python's `union_pattern` and also a Python *string*, which
      names `string_start`, `string_content` and `string_end` where
      TypeScript's has one `string_fragment`. One `case "GET"` came back as
      four unreadable shapes in Python and one clean case everywhere else.
    - **An identifier test applied to a string.** `case "textDocument/hover"`,
      `"&str" | "String" =>` are ordinary constants whose text is not an
      identifier. The quoted check also has to be asked *before* descending,
      because descending into a `string` is what strips the quotes.
    - **A catch-all in a branch with anything else in it was lost.** A grammar
      puts only the first statement of a case behind `body`, so a `default:`
      holding two statements leaves a loose child over and it was read as the
      label -- django's `popup_response.js` reported `break_statement`, vite's
      `build.ts` reported `comment`. **This one runs toward a false red:** a
      `default:` misread as a labelled case means the dispatch is reported with
      no catch-all, so a routine that swallows every unlisted case looks like
      one that enumerates them. TypeScript's catch-all count 116 -> 134.
    - **A comment was a case, and then a catch-all.** A comment is a *named*
      node in all five grammars. One loose in a `match_block` was read as a
      branch with no label, which is the spelling of a wildcard, so **every
      Rust match with a comment in it was reported as having a catch-all it
      does not have.** Rust 216 -> 184, Python 132 -> 115. The safe direction of
      the same defect: it cost refutability rather than inventing a red.
    - **`case Status.Active:` was the commonest shape it could not read** -- 271
      of 5,269 cases, against 95 for the next one. The first fix used
      `parse.ts`'s `MEMBER_ACCESS` on the one-list argument and read **0** of
      Python's, because a `case` pattern is a `dotted_name` there while the
      same expression elsewhere in Python is an `attribute`. That set answers a
      different question; sharing it would have been one list used for two
      things. A dotted or `::`-joined run of identifiers is the same shape
      everywhere.
    - **A bare identifier means opposite things in the two families.** `case
      ready:` in a `switch` is a value; `x => ..` in a `match` is a *binding*
      that catches everything, and reading it as a case put `x` in the set five
      times in `ripgrep/tests/json.rs`. The first fix refused every unqualified
      identifier in a pattern and **cost 372 Rust cases and 21 Python ones**,
      because bare `None`, `Ok` and `Err` are exactly that shape -- refused
      dispatches went 134 to 506. It now leans on case, which is what
      discriminates in practice, and answers **catch-all** rather than case or
      refusal: if that is wrong the claim gets quieter rather than accusing
      anybody.

    **Five referee bugs, which is the other half of the pattern.** The first
    run of `measure:handles` reported **1,409 disagreeing files**, and the
    referee was wrong in every one of the first four:

    - **Two chain patterns that matched every `if`.** A chain link and an
      ordinary `if (x === undefined)` are the same text. Telling them apart
      needs the links collected and their subjects compared, which is the
      reader's own judgement written twice, and a second copy of the reader is
      not a referee. **So the chain half of the word has no referee and
      `checkHandles` refuses to accuse on it, in every language.** That is the
      gate working rather than a gap.
    - **A `case` pattern anchored at end of line**, so `case 2: return x;` and
      every minified file was invisible. django's vendored `xregexp.min.js` hid
      twelve cases that way.
    - **One `case` per line.** `case 2:case 3:case 4:` is one line.
    - **No payload rule**, so `Ok(v)`, `Err(e)`, `Event::Click { .. }` -- how
      Rust writes patterns constantly -- were refused. This and the one above
      were most of a **52.50%** disagreement, which came down to 3.76%.
    - **A comment stripper that tripped on `/*` inside a string.** A CSS
      string, a glob, a regex: the block-comment flag went on and **blanked the
      rest of the file**. The scan read 0 of 2 case labels in vite's
      `importMetaGlob.ts`, 2 of 6 in `create-vite`, 10 of 12 in `css.ts`, and
      every one came out as the reader inventing a case. Rewritten as a
      character scanner that tracks quote state, which took TypeScript from 8
      invented to **0**.

    **One referee change was built, measured and reverted**, which is worth as
    much as the five above. `rustfmt` breaks a long arm across lines, so a
    line-based scan cannot see it -- 116 of Rust's disagreements. Joining a run
    of lines up to the one holding `=>` took the numbers from 3.76%/2.85% to
    **5.39%/5.02%**, because deciding which lines are a continuation is itself a
    judgement and it joined unrelated ones. A referee tuned until it flatters
    the reader has stopped being a referee.

    **The numbers, `npm run measure:handles`, 9,940 files over sixteen trees.**

    | language | files | dispatches | cases | referee | invented | missed |
    |---|---:|---:|---:|---:|---:|---:|
    | ts | 3,918 | 176 | 1,099 | 1,106 | **0** | 7 (0.64%) |
    | rust | 290 | 1,042 | 2,959 | 3,021 | 105 (3.55%) | 167 (5.56%) |
    | tsx | 656 | 12 | 40 | 41 | 2 | 3 |
    | python | 3,957 | 9 | 26 | 26 | 6 | 6 |
    | js | 1,119 | 9 | 27 | 27 | **0** | **0** |

    **Both halves of this word accuse, so unlike `@calls` there is no direction
    that is merely quiet.** An invented case tells somebody their picture is
    short of a case their code does not have; a missed one tells them their
    routine has no arm for something it handles. Both are false reds. That is
    why zero in the invented column is the number TypeScript's licence rests
    on, and all 7 of its misses are the referee reading a `switch` written
    inside a template literal in a test fixture -- it has to keep strings,
    because a case label is one.

    **Rust is the finding.** #206 called it "the strongest case by a distance"
    -- exhaustive by the compiler, and the reader does read it: 1,042
    dispatches and 2,959 cases, the largest population here by a factor of
    three. It is a stated **no**, and the reason is the referee rather than the
    reader. Every disagreement was read and almost all are the three known
    blind spots. Item 18 already settled that this is not enough: agreement is
    not evidence once a check is known not to discriminate. `rustc`'s own
    non-exhaustive-match error is the independent oracle that would settle it,
    and #237 found this machine's rustc too old for ripgrep's crates.

    **Two things the grid had to grow.** `handles` is the first **box** word on
    it -- `closed` is deliberately not, because it reads the imports `@needs`
    is measured on and asks `licenceFor` about a path instead, while a dispatch
    is a reader nothing else here has. And **TS and TSX are separate columns
    now**: they agreed on every word for eight words running, so one column
    said both, and this is the first word where they do not. A table that
    cannot say so has to round one of them, and rounding up grants a licence
    nobody measured.

    **What it does not cover.** The `if`/`elif` half, refused in every
    language. A routine with two dispatches, refused. A case the reader cannot
    name -- a tuple pattern, a Rust byte range, a computed label -- refuses the
    whole dispatch rather than shortening the list, 157 of them across the
    corpus. And the comparison in `measure:handles` is per **file** rather than
    per routine, because a referee that bounded a dispatch would be a second
    copy of the reader; what guards attribution is the scoping tests and the
    two-dispatch refusal, not that number.

39. **The instrument the issue named would not have worked, and the one that
    does reported a clean run over a suite that had not run.** #273 asked for a
    TypeScript referee and named V8's CPU profiler as the likely way. Measured,
    it is not: at a 200us sampling interval over nestjs's 276 files and 2,739
    tests it saw **123 distinct `file#name` frames**, nearly all of them
    anonymous module initialisation, because that suite spends 4 seconds of 19
    actually running tests. A profile is a set of samples, and the calls a
    referee has to see are the cheap ones.

    What replaced it is an entry hook inserted by a vite plugin, with caller and
    callee read off the real JS stack -- `reach_trace.py`'s logic, on V8 frames.
    A shadow stack would be cheaper and is **wrong in Node**: an `await` unwinds
    while the function is still on it, so every edge until it resumes is
    attributed to a function that is not running, and a referee that invents an
    edge invents the false accusation to go with it.

    **Then the second kind of finding, and it is the one worth remembering.**
    The first vite score was read off a run that reported `0 failed`. It was
    not: **45 of its 67 suites had failed to parse**, because vite is written
    without semicolons and the hook went in behind a bare `super()`. A suite
    that fails to *collect* reports no tests rather than a failure, so the run
    exits 0 and the trace holds a fraction of the code -- the same shape as
    items 33 to 35, one layer further out, and found by asking what a suspiciously
    small population meant rather than by anything going red. `trace-reach.mts`
    now refuses to write a trace when any file collected no tests, and separates
    that from a test that ran and failed on its own timing, which is a real
    consequence of a hook on every call and does not invalidate anything.

    Three more, each now a test in `tests/reach-trace-node.test.ts`: a project
    that owns `Error.prepareStackTrace` handed back a stack of the wrong shape
    (9 of vite's suites); the runtime, copied into the clone so vue's jsdom
    project could resolve it, was instrumented by its own plugin and every one
    of vue's 183 files died in `Maximum call stack size exceeded`; and a marker
    appended to a file whose last line is a `//` comment lands inside the
    comment, which parses, does nothing, and silently drops every later edge
    through that file.

40. **Every licence row #274's sweep touched cited a command that could not
    reproduce it, and re-running it on a corpus that can found the referees had
    never met real code.** Nothing lost its licence (#278).

    The `holds`, `builds`, `conforms`, `takes` and `returns` rows said
    `reproduce: "npm run measure:holds"` and nothing else. With no arguments the
    script reads the seven trees on disk, and this repository is two of them, so
    the count moves with every commit: the TypeScript `holds` row said 1,195 and
    the command prints 1,284. Nobody could tell from the row which run produced
    its number, and so nobody could confirm #274's blind walk had not -- it had
    not, the rows are dated before the trees went missing on 2026-09-07, but a
    date is an inference and a command is a measurement.

    So every one of those rows now names `.corpus/*`, the fifteen clones the
    dependency licence already pins, and was re-measured there:

    | row | cited before | bare command today | `.corpus/*`, now cited |
    |---|---|---|---|
    | `holds` ts+tsx | 1,195 · 0 missed | 1,284 · 0 | **688 · 3 missed** |
    | `holds` rust | 47 · 0 | 62 · 0 | **1,813 · 2** |
    | `holds` python | 2,177 · 0 | 2,177 · 0 | **2,300 · 241** |
    | `builds` ts+tsx | 225 · 0 | 227 · 0 | **1,050 · 10** |
    | `builds` rust | 66 · 0 | 75 · 0 | **1,481 · 93** |
    | `conforms` ts+tsx | 376 · 0 accused | 379 · 0 | **956 · 32 accused** |
    | `conforms` python | 2,276 · 0 | 2,276 · 0 | **14,238 · 0** |
    | `conforms` rust, a stated no | 4,975 · 0 | — | 4,975 · 0, the five Rust clones |
    | `takes`/`returns` ts+tsx | 1,842 · 0 | 3,167 · 0 | **22,793 · 80** |
    | `takes`/`returns` rust | 154 · 0 | 154 · 0 | **32,719 · 0** |
    | `takes`/`returns` python | 4,002 · 0 | 4,002 · 0 | **25,151 · 0** |

    Invented is 0 in every cell that counts it (`measure:signature` does not).
    **Every one of the 461 disagreements was read, and the reader is right about
    all of them.** They are the referee, and the shapes are ones no tree on this
    machine writes much of: a docstring's `Args:` list read as fields (168 of
    Python's 241), a class written inside a string that a test loads as a
    module, a Rust `match` arm or `if id == DEAD {` read as a construction (88 of
    Rust's 93), a TypeScript header over several lines whose type arguments were
    read as bases (30 of 32), a NestJS decorator's argument
    `@Body({ schema: mockSchema })` read as a parameter's type (38 of the 80
    signature misses). Each row's `known`
    lists them with counts. The one real construction among them is inside a
    `macro_rules!` body, which no reader here parses.

    The zeros the rows used to carry were true and said less than they seemed
    to: a referee tuned against the trees at hand is only known to agree with
    the reader on those trees. The referees are left as they are, on purpose.
    Teaching a scan to skip docstrings is right, and it is also the move that
    makes a referee agree with the reader, so each fix needs its own argument
    rather than arriving as a batch that happens to take the misses to zero.

    Two more corpus paths were pointing into `.claude/worktrees/96-rust`, a
    worktree that can be removed, under clone names nothing else uses:
    `measure-survey.mts`, `probe-generative.mts` and the Rust example in
    `measure-conforms.mts`' header. They name `.corpus` now.

41. **"The right relationship at the wrong altitude" has one definition that
    survives, it covers the easy quarter, and the shape it covers was being
    passed on nothing.** #280, gap 2 of #217. Five candidates were tried against
    the 221 arrows on 17 code boards (`board-ai`, `~/orangutan`, and one board
    that ships inside the vuejs-core clone). Apart from that one they are the
    owner's test boards, so every count below says whether the rule *can* be read, never whether
    anybody wants it. "Right" and "wrong" below are a person reading the box
    label against the code, not a script.

    `npm run measure:altitude` prints every hit for that reading. The corpus
    starts from the directory it is run in, and these numbers are from the main
    checkout, which also holds untracked boards (`claim-path`,
    `how-it-reaches-you`, `rust-test`). From a clean checkout it reads 150 arrows
    on 12 boards, 28 of 56 file boxes and 13 of 53 arrows for the last two rows,
    and **the same 9** for the one that survived.

    | candidate | fires on | right | wrong |
    |---|---:|---:|---:|
    | a box anchored at a whole file | every file-anchored end | — | nearly all: `drift check`, `read / write the file` are summaries on purpose |
    | an arrow joining a file end to a symbol end | 27 | 9 | 18: `check-drift.mjs -> checkDrift`, `checkDrift -> graph.ts "nodes · refs"`, the generated macro module |
    | the file box's label names something the file declares | 30 of 62 boxes | 5, all Rust (`conns: Slab<Client>`, `tpool`) | 25: "read", "server", "layout", "board" are ordinary words *and* declarations |
    | the evidence for a file-level arrow sits inside one declaration | 13 of 56 (TS/JS) | 0 | 13: `App.tsx -> reveal.ts` is the component, `render-diagram.mjs` is the script |
    | **both ends in one file, at least one of them the whole file** | **9** | **8** | **1** |

    The survivor is the issue's own example in its narrowest form: a box for
    `conns` or `tpool`, both fields of `Orangutan`, anchored at `src/lib.rs`,
    with an arrow from a routine in `src/lib.rs`. The one it gets wrong is
    `route -> "generated mod route_<fn>"`, macro output that has no declaration
    to anchor at, so the file really is the finest anchor there is.

    **It was also a false green, in all three languages.** Every file-level
    channel asks about two files, and here there is one. The shared-importer
    channel said yes whenever the board showed anything that imports that file:
    4 of the 9 were green, all on the two boards that also show `main.rs` and
    other files of the crate. The third board shows only `src/lib.rs`, and its 5
    were not. Tested per shape in
    `tests/engine-altitude.test.ts` -- routine to file, file to routine, two
    boxes on one file, TypeScript, Rust, Python, and a `planned` arrow that was
    being told the code had already built it. The other 5 were amber
    `nothing-connects-them`, which is true and useless.

    The same one-file question was reached by one more shape, not an altitude:
    two named ends with no body on either side. `rcache -> routes`, two fields
    of `Orangutan`, was green the same way and is now `no-function-body`, the
    reason that shape already had when the file could not be placed.

    Now all 9 are unread, `ends-in-one-file`, with the fix in the words: anchor
    the end at the thing it stands for. A skip, like `directory-ref`, so a
    deliberate summary is never called wrong. Re-anchored at the field or
    routine each label names, **7 of the 8 that can be re-anchored confirm by
    reading bodies**, and the eighth is `accept -> conns`, which is a wrong
    arrow: the `conns.insert_with` is in `ready`, not `accept`. The file anchor
    had been hiding that.

    **The cost, on the record: 5 greens gone**, the 4 above and `rcache ->
    routes`. The 4 confirm once re-anchored, so they were right, but nothing had
    read them. **211 of the 221 arrows are unchanged.**

    The engine's own advice was half of how the shape got drawn: `an-end-is-data`
    said "anchor that end at file level", which with the other end in the same
    file lands exactly here. That sentence now says so, in the per-arrow detail,
    the words table and `create_diagram`'s note.

    **What it does not cover, and this is most of the gap.** 9 of the 35 arrows
    whose two anchored ends sit at different altitudes (27 file-to-symbol, 7
    directory-to-file, 1 onto a missing file). The 9 are the easy part, the only
    one where the check provably had nothing to read. The shape #217 actually
    describes, a module box on an arrow that is really about two functions *in
    different files*, has no definition that separates it from a deliberate
    summary. It is on the corpus once -- `tpool -> hello_handler`, the same
    `tpool` box pointing into `main.rs` -- among 18 cross-file arrows of that
    kind, and the other 17 read as summaries on purpose. The 54 file-to-file
    arrows could hide the same thing, and nothing here can tell. Recorded under "not being built".

42. **A real Rust parser found the reader's bug, not the referee's, and
    Rust's `@handles` square went from no to yes (#267).**

    #267 priced two ways to build a referee `dispatch-scan.ts`'s line-based
    scan cannot be, for the language holding three times any other's dispatch
    population. `rustc`'s own non-exhaustive-match error was the first
    candidate and it is still blocked: `.corpus/ripgrep` declares
    `rust-version = "1.96"`, this machine has `1.93.0`. The second was a small
    binary parsing every file with `syn` -- the crate the Rust ecosystem
    itself parses Rust with -- and that one is not blocked: it built in
    seconds and read all 929 Rust files on this machine without a parse
    failure, ripgrep included.

    Wired in as `scripts/rust/matcharm-reader` + `scripts/lib/dispatch-scan-rust.ts`
    and run against the reader, the first numbers looked worse than
    `dispatch-scan.ts`'s, not better: invented held at 15, but missed rose
    from 167 to 210. That is backwards for a referee that is supposed to be
    more trustworthy, and it did not get explained away -- every disagreement
    was read against the real code, not just counted.

    Two were reader bugs, not referee ones, both in `namesIn`/`isBinding`
    (`src/engine/handles.ts`), and both fixed there rather than worked around:

    - `match flag { true => .., false => .. }` read as two *bindings*, because
      `isBinding`'s test is "a lowercase identifier in pattern position", and
      `true`/`false` are lowercase. Unlike an ordinary lowercase word, a
      Rust keyword can never be a binding name, so excluding exactly these two
      spellings costs nothing. This alone moved missed from 210 to 182 -- the
      dispatch had gone from *silently confirmable* to *silently withheld
      forever*, never to a wrong verdict, because `checkHandles`'s catch-all
      rule already excuses a claimed case the code does not name.
    - `ref x => panic!(..)` and `t if t < 0 => ..` read as *invented* cases
      named `x` and `t`, because the same regex expected a bare identifier
      and got one wearing a `ref`/`mut` modifier or a trailing guard.
      Unlike a missed case, `catchAll` does not excuse an invented one --
      `ripgrep/tests/json.rs` had five dispatches where the reader would have
      told an accurate box it was missing a case the code does not have. This
      moved invented from 15 to 7.

    What was left after both fixes was read case by case against
    `checkHandles`'s own logic rather than against a percentage: **every one
    of the 182 remaining missed cases, and 2 of the 7 remaining invented
    ones, sit inside a dispatch the reader already marks `unreadable` for an
    unrelated arm** -- a tuple pattern, a slice pattern, a range pattern, or a
    `#[cfg(..)]`-gated arm (ripgrep's PCRE2 backend). `checkHandles` withholds
    the whole dispatch the moment any one arm is unreadable, before the case
    lists are ever compared, so none of these can print as a wrong verdict.

    **The other 5 invented are a real, narrow residual, disclosed rather than
    hidden**: a char literal (`'\t'`, `'\\'`) where `syn` decodes the escape
    to the one real character and the reader keeps its two-character source
    spelling, on a dispatch that carries a catch-all but no unreadable arm --
    and a catch-all excuses a missing claim, never an extra one. A box
    claiming this exact routine's control-character cases by their decoded
    spelling could still be told it named one the code does not have. The
    whole corpus has zero boxes claiming `handles` on any char dispatch, which
    is why this ships disclosed rather than waiting on a fix nobody has a
    real test case for.

    `src/engine/licence.ts`'s Rust `handles.presence` and the grid row in this
    file both moved from no to yes on these numbers. `src/engine/handles.ts`
    itself -- the reader every language shares -- is more correct than it was
    for TypeScript, Python and JavaScript too, not only for Rust.

42. **A field list is not a closed region if most of it is written in the
    constructor, and three readers of one declaration disagreed about the same
    class.** #303, from #300's fixtures and #301's test set. Three findings
    under one heading, because each one is a reader believing it had read the
    whole of something.

    **Fields declared in a constructor.** `constructor(public dep: Dep)` and
    `self._request: Request | None = request` both declare a field with nothing
    in the class body to say so, and `holds.ts` stopped at the first member
    carrying a parameter list. That is **7 of the 8 false reds `bench:planted`
    reported** — vue's `Link`, two classes in nest, and one each in httpx,
    flask and poetry — and the shape is in almost every TypeScript and Python
    class ever written. It needed no licence, because reading more names can
    only turn an absence into a confirmation: no accusation here is new.

    `accesses.ts` had already found both shapes, for member *names*, and read
    them correctly. So the field reader and the member reader disagreed about
    what one class declares, which is `docs/reading-a-grammar.md`'s failure in
    its purest form — two hand-written readings of one grammar, silently out of
    step. Both now read `declaresField` and `INSTANCE_NAMES` out of `parse.ts`,
    beside `MEMBER_ACCESS`, which is there for the same reason. Sharing the name
    set also closed a latent false red on `@accesses`: `this.x = v` was not read
    as a member, so a TypeScript class that sets its members in its constructor
    and writes none of them in its body refuted every arrow naming one.

    **An alias declared beside the type, not beside the signature.** Both
    refutable readers of a declaration kept their own copy of "what in this file
    stands for something else", and neither copy could see the ordinary case:
    `use crate::model::{Req, Request}` marks neither name as a rename, and only
    `model.rs` says `pub type Req = Request`. #300's fixtures scored that at
    **9 of 9** — `@takes`, `@returns` and `@holds`, in all three languages —
    against a guide that promises silence. Python was worse: it went red for an
    alias declared on the line above, because Python spells one as an ordinary
    assignment and has no node type for it. The stale list again.

    Both copies are now `alias.ts`, and the file declaring the type is read for
    the other names it calls it by. One hop, deliberately: a chain is a question
    for a type checker, and what a chain costs is the red that was already
    there. The refusal stays a set of *names* rather than a flag on a file,
    which is what keeps the word firing — a signature whose every name means
    itself is still refutable however many aliases sit elsewhere, and
    `bench:claims` shows every `false and provable` square still red.

    **What it cost, exactly one claim, and it is the right answer.** A planted
    wrong-kind arrow on vue's `ComputedRefImpl` was red and is now *not sure*.
    Reading the constructor is why: `ComputedRefImpl` declares its fields there
    as `ComputedGetter<T>` and `ComputedSetter<T>`, both type aliases in that
    same file, and a field list with an alias in it cannot refute — the rule
    that was always there, applied to the part of the field list nothing used to
    read. The mistake is still on the report; it is no longer an accusation.
    That is the whole of the cost: `bench:planted` moves from 386 reds on false
    claims to 385, and from 8 false reds to 1.

    **A reason invented out of a path resolved twice.** `@accesses`' one escape
    hatch is the routine that calls a helper which reads the member — `draw
    --calls--> paint --accesses--> Config` drawn one level too high rather than
    wrong. `helperReading` was handed an absolute path, and `workspace.resolve`
    refuses one by design, so it failed on every real board and reported the
    routine as making one call nobody could see into. The red then described a
    call the routine did not make, on a routine that called nothing at all.
    Every test it had passed, because the workspace the tests build resolves a
    relative path to itself — `AGENTS.md`'s own lesson about the board-sync bug,
    one file over. Its tests now resolve the way `createWorkspace` does.

    **What is left, and it is not fixable from here.** The eighth false red is
    `@needs` in clap. `debug_asserts.rs` imports `Command` and writes the path
    the crate root re-exports it under; `resolveRustPath` stops at the first
    segment with no file of its own, by design — a re-exported *item* lives
    inside a file the re-exporting module already depends on, which is true of
    that module and not of the file importing through it. So the forward
    dependency lands on `lib.rs`, the backward one is read directly, and a legal
    cycle is reported as an arrow drawn backwards.

    Following item re-exports would fix it and confirm the arrow: `lib.rs` says
    `pub use crate::builder::Command`, `builder/mod.rs` says `pub use
    command::Command`, and two hops reach the declaration. It also adds resolved
    dependency edges everywhere, and an edge found only in the head turns an
    `absent` into a `backwards` — a new accusation, which needs `measure:deps`
    against an independent referee before it may ship. Refusing instead is sound
    and far too wide: `use crate::X` is how Rust is written, so withholding
    wherever a name arrives through a facade would withdraw most of Rust's
    `backwards` verdicts, and that is the column this work may not spend.

    **The wrong kind of end, decided and written down.** #297 made it red and
    left the `@takes`/`@returns`-at-a-type square open. It is red in all three
    languages, and `bench/claim-fixtures.ts` now says so. Python reaches the
    verdict by a different sentence — the signature reader finds `__init__` and
    quotes it, because a Python class really does have a constructor with a
    signature and answers before the end's kind is asked about. Same verdict,
    less direct sentence; making the sentences agree would mean stopping
    `signatureNode` descending into a class body, which turns a green into a red
    wherever a constructor's parameter names the type, and that is a new
    accusation too.

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

   Re-checked against `reach.ts`, a real interprocedural walk, and the answer
   held: 402 more resolvable sites of 20,209 refusals (item 34). The number to
   beat is **19.3%** on a corpus of 1,500 files, and the bar is met — 0 leaked,
   0 invented — which item 33 is the reason for. What the re-check found instead
   is that the call question is only ever put to **bare** calls, so 45.3% of the
   values with a call-shaped exit have never been in it.

   The next step was chosen as the confirming half — **does this value reach a
   door** (item 35) — and its one prerequisite is built: the site for a call on
   a receiver is now recorded, unnamed, so Python's doors went from 16 of 127 to
   127 of 127 and the refusal `callee-is-a-method` is now the largest reason a
   value stays trapped at 49.5% (item 36). That also removed seven false
   `contained`, none of which had ever been counted as a leak.

   The door question itself is now **built and measured, and the measurement
   says do not ship it** (item 37): 309 flows at 0 invented, but 242 of them are
   a filename rather than the data, and the seven that mean what the question
   asked are all one `git(args)` idiom. Refuting it remains the thing not to do
   at all.

   So #203 stays open with its ordering intact and one fewer candidate. What
   would change the answer is a structure abstraction -- `fetch(url, { body })`
   is the commonest door in TypeScript and is invisible -- and **not** a count of
   arrows on the boards in this repository, which are the owner's own test
   diagrams and cannot answer demand for anything (item 37).
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
- **A wrong-altitude check across files** (#280). No definition separated a
  module box on an arrow about two functions in two files from a deliberate
  summary; see item 41 for the four that were tried. What would change this is
  a reader that says which declaration an arrow's evidence sits in *and* a
  signal of intent that is not the label, because labels failed as that signal.
- **A relation for "this function fits that field's function-pointer type"**,
  which is what the orangutan arrow actually wants. Real, and probably not worth
  a word.

- **Calling an arrow onto something outside the repository wrong** (#58). An
  arrow onto a file, a service or another process names nothing the checker can
  read, but the code that talks to that thing -- its door -- is in the
  repository and can be found: `npm run measure:doors` finds calls to files, the
  network and processes in the twelve pinned repositories, wrong at most once
  per language, and real code reaches the outside from a handful of routines
  (django: 101 of 6,393 touch the disk). So confirming an arrow onto a door is
  within reach.

  Refuting one is not yet, and what is left in the way is now one thing rather
  than two. It needs "this routine never reaches that door", which is the
  opposite direction from the chain following item 28 built: that one *confirms*
  a route and got 321 of 406 distant pairs where 98 were confirmed before, while
  this one has to establish that no route exists at all. Forwards, one unplaced
  call anywhere on any path ends that proof, so it is proved backwards from the
  door instead (`npm run measure:door-reach`). Scored against flask's and httpx's test
  suites **as they actually ran** (`scripts/lib/reach_trace.py`), a referee
  sharing no parse, index or name with the walk, the walk now rules out **0 of
  90** (routine, door) pairs that do reach. Three rules got it there, each one
  measured before the next: reading every name a routine uses rather than only
  the names it calls (55 -> 5), counting `HTTPTransport(..)` as running its
  `__init__` (5 -> 2), and following a routine handed to a library and kept in
  a module-level or class-level name -- flask stores a callback in a
  `click.Option` and click runs it (2 -> 0).

  What that costs is the other half of the answer: it rules out **16.5%** of
  TypeScript routines per door, **8.7%** of Python's and **9.2%** of Rust's. So
  most arrows stay unjudgeable even where the walk is right.

  **TypeScript now has a run-time referee too, and the walk survives it**
  (#273). `npm run trace:reach -- --repo=vitejs-vite` records which of a
  repository's own routines called which while its own vitest suite ran, in the
  same shape `reach_trace.py` writes, and `measure:door-reach --trace=` scores
  it unchanged. Over five repositories in two languages the walk rules out **0
  of 1,423** (routine, door) pairs that do reach, against **117** for the
  `calls` baseline it replaced:

  | | doors reached | pairs | `calls` | `mentions` | `callbacks` |
  |---|---|---|---|---|---|
  | vitejs/vite | 47 of 119 | 1,328 | 61 | **0** | **0** |
  | nestjs/nest | 1 of 34 | 5 | 1 | **0** | **0** |
  | vuejs/core | 0 of 17 | 0 | -- | -- | -- |
  | pallets/flask | 3 | 12 | 5 | 2 | **0** |
  | encode/httpx | 3 | 78 | 50 | **0** | **0** |

  vite is the find: its suite is the only one in the corpus that really touches
  the disk, and it alone carries **fifteen times the whole Python evidence
  base**. vue is the other half of the lesson -- 3,681 tests, 3,937 edges and
  **not one door**, because a reactivity suite has no reason to open a file. A
  language's referee is only as good as whether its suites go near the outside.

  **What that evidence does not cover, said plainly.** The tests reached 48 of
  the 170 doors in the three TypeScript repositories, and each trace sees only
  the paths its own suite ran: vite's loaded 101 of 1,564 source files (6.5%),
  nest's 300 of 1,904 (15.8%), vue's 198 of 527 (37.6%), flask's 19 of 83
  (22.9%), httpx's 20 of 60 (33.3%). So 0 is still a floor and not a rate, and
  it covers **two of the three languages**. Rust has no referee -- see below --
  and `excalidraw` and `TanStack/query` were not traced, so nothing here says
  anything about them.

  **Rust: there is no referee, and the reason is not the one expected.** #273
  guessed the obstacle was that calls are compiled and inlined so a profiler's
  stacks are not a call graph. Half right. A sampling profiler is indeed
  useless, and that is true of Node as well: V8's CPU profiler at a 200us
  interval over nestjs's 276 files and 2,739 tests saw **123 distinct
  `file#name` frames**, almost all of them anonymous module initialisation. But
  a Rust *backtrace* is fine. In a debug `cargo test` build it names the whole
  caller chain, file and line included, at **9.5us a capture** -- the same order
  as the 3.0-7.5us the Node referee pays for `Error.captureStackTrace`, which
  is how it attributes every edge it records.

  The blocker is that there is nowhere to put the hook. Node's referee exists
  because vitest already routes every module through a transform, so a plugin
  can insert an entry hook without touching the repository. `cargo test`
  compiles from source and offers no such seam: instrumenting would mean
  rewriting a pinned crate's `.rs` files and its manifest, and the part it could
  not reach is the part that already sank the crate-wide Rust reader above -- a
  function written inside a `macro_rules!` body is an unparsed token tree to any
  source-level instrumenter. So the Rust half is **a written answer rather than
  a promise**, which is what #273 asked for. Two facts worth not re-deriving:
  the toolchain and the suites are ready (`cargo test --no-run` is clean on
  `anyhow`), and the backtrace is not what is in the way.

  **So the remaining blocker is one language, not the referee as such.** A false
  red is not recoverable, and two languages' evidence is not three. Refuting an
  arrow onto a door is arguable on its merits in TypeScript and Python now, and
  it still would not obviously be worth shipping: the walk rules out 8.7% to
  16.5% of routines per door, so most arrows stay unjudgeable even where it is
  right, and that trade is a separate decision (#273 defers it on purpose).

  Two things were measured and rejected on the way, and the numbers are the
  reason both are written down rather than retried. Staying quiet on any door
  whose set holds a routine a library could call back silences **every door in
  the corpus** -- 204 of 204 in TypeScript, 161 of 161 in Python, 46 of 48 in
  Rust -- so it refutes nothing anywhere. And reading held names inside routine
  bodies, rather than only at the top of a file or a class, drops what can be
  ruled out to **4.6% / 2.6% / 2.5%**: a body's locals (`value`, `name`,
  `path`, `key`) then hold most of a repository, `value` alone adding 128 of
  flask's pairs.

## A note on that orangutan arrow

`orangutan/docs/diagrams/route-registration.excalidraw` carries
`RouteInfo --[parameter @takes]--> hello_handler` and reports red. #188 tells
this as an authoring failure — somebody reaching for the nearest word and being
accused. **It is not: it is the owner's test that a false claim goes red.**

The red is correct and should stay. `@takes` is false there — `hello_handler`
takes a `&Request`. And `@holds` is not true either, because the far end is a
function rather than a type, which is now caught as a category error.

Worth knowing before reading #188's framing, and worth not "fixing".
