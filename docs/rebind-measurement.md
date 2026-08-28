# Measured: could a stale ref have been followed on its own?

Answer to issue #140, measured on 2026-08-28. A measurement, not a feature —
nothing below is implemented, and the deliberate order is the issue's: no
rebinding code until there is a number.

Reproduce it with `npm run measure:rebind`. The harness is
`scripts/lib/rebind.ts`, the report is `scripts/measure-rebind.mts`, and the
numbers are committed in `src/engine/rebind.ts` so `--check` fails when they
move.

## The finding first

**Ambiguity is rare. Following the wrong channel is the real risk.**

Across two histories, 281 anchors broke. One of them was ambiguous. That is the
number the issue said would decide the feature, and it says the feature is
buildable rather than blocked.

But "exactly one candidate" is not the same guard for every channel. Every wrong
or ambiguous answer in both histories came from the weakest one — matching by
filename — and every one of those involved a file called `index.ts` or
`__init__.py`. A name every directory has identifies nothing, so it produced one
candidate confidently and the candidate was somebody else's file.

Rename evidence and symbol evidence produced 137 answers between them and no
wrong ones that could be found.

## The numbers

### This repository's own boards — the sample that counts, and it is empty

| | |
| --- | --- |
| range | `c827cee`..`245aad6`, 99 first-parent commits |
| anchors | 75 refs seen alive |
| chances | 407 (a commit changed the file a live ref pointed at) |
| broke | **0** |

Not "no ambiguity" — no data at all. The boards here were drawn after the code
they describe had stopped moving. 407 times a commit touched a file a board was
pointing at, and every one of those refs still resolved afterwards.

An empty sample decides nothing, which is why the two below exist.

### Every file that left this tree — hypothetical, weaker

Each vanished source file treated as though a board had pointed at it, and each
symbol it exported as though a box had named it.

| | |
| --- | --- |
| anchors | 152, across 2 commits |
| followable | 31 (20.4%) — 24 by rename, 3 by symbol, 4 by filename |
| **ambiguous** | **0** |
| gone | 121 (79.6%) |

The 79.6% is one event, not a rate: 148 of the 152 anchors come from the day the
Electron app was deleted wholesale, and code that was deleted is correctly
`gone`. Strip that commit out and what is left is two file renames — a module and its
test — which the rename channel followed along with all 22 symbols the module
exported.

### Graphify, 1431 commits — for size

`Graphify-Labs/graphify` at `b2cd362`, the same hypothetical walk, a Python
codebase rather than a TypeScript one.

| | |
| --- | --- |
| anchors | 129, across 3 commits |
| followable | 110 (85.3%) — 95 by rename, 15 by symbol, 0 by filename |
| **ambiguous** | **1** (0.8%) |
| gone | 18 (14.0%) |

Re-derive with `npm run measure:rebind -- --repo=<clone>`. `--check` does not
verify this one: it needs a clone, and a check that needs the network is a check
that gets skipped.

## What the buckets do not tell you

`followable` says a machine could have picked an answer. It does not say the
answer was right. The only ground truth available is a human going back and
editing that box's ref by hand, and the harness looks forward through the
history for exactly that.

It found none. Every followable answer in every sample is `unfixed` — the
hypothetical anchors have no boxes to correct, and the one real board involved
was never touched again. So the correctness of the rebind is argued from the
cases, below, and not from a count.

## The one ambiguous case, and the two wrong ones

The single ambiguity in 281 anchors:

```
src/graphify/__init__.py  ->  graphify/__init__.py   or   tests/__init__.py
```

And the two answers this repository's own history produced that are plainly
wrong, both from the filename channel, both confident because they found exactly
one candidate:

```
src/main/index.ts    ->  src/viewer/main.tsx     (Electron main process -> browser entry point)
src/server/index.ts  ->  src/mcp/server.ts
```

One pattern, three times. `index.ts` and `__init__.py` are not names, they are
positions. Matching on them is matching on nothing.

The same channel got two right in the same commit —
`src/renderer/App.tsx -> src/viewer/App.tsx` and `src/renderer/main.tsx ->
src/viewer/main.tsx` — and both of those matched on a real basename. The symbol
channel confirmed the first of them independently.

## What this says the feature should be

Opinion from here down, resting on the numbers above. **The first half of it
shipped**: the drift report now follows a stale anchor and prints where the code
went, on the two channels below and never on the third. It does not write to a
board. `docs/drift-check.md` has the section, `src/engine/follow.ts` the code.

**Rebind on rename evidence and symbol evidence. Never on a filename alone.**

- **rename** — git recorded it. A fact about what a human did, and the strongest
  thing available. 119 answers across both histories, no wrong ones found.
- **symbol** — the name is declared in exactly one file in the tree now.
  Declared, not mentioned: a call site is not a place to re-aim a box. 18
  answers, no wrong ones found.
- **filename** — drop it, or demote it to a proposal a human confirms. It is the
  only source of error in either history, and its failures are silent and
  confident.

The `exactly one candidate` guard stays, on every channel. Everything else stays
a finding that says why, in the same amber discipline as the rest of the check.
Hand-drawn elements are never touched.

## What would change the answer

- **A repository that renames more.** Five breaking commits in 1530 is a thin
  base for a rate. `--repo` exists so this is one command, not a rewrite.
- **A board with refs on moving code.** The sample that actually matters is
  still empty here. It fills on its own as these boards age.
- **A wrong rebind found in the wild.** One would be worth more than all of the
  above, and the harness would then have something to score against.
