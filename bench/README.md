# The planted-mistake test set (#296)

Boards of real code, with the true answer for every claim taken from the
language's own tooling, and mistakes planted in them by a script. The score
says how many of those mistakes the checker calls wrong, how many it shows as
not sure, and how many pass in silence — and, the number that matters most,
how many *correct* claims it calls wrong.

```
npm run bench:planted                      # the score table
npm run bench:planted -- --language=rust --details
```

That command reads only what is stored here. It calls no model and no language
server. It takes about a minute: since #311 one cache is held per project for
the whole run, instead of every one of the 1,661 arrows re-reading the same
files -- which is what made it an hour. What one arrow costs, asked twice:

```
npm run probe:check-cost                   # cold, and through a held cache
```

## The undecided half, and the ceiling (#320)

Half of every claim here comes back neither red nor green, and that one number
was covering three different situations. The run now ends with the split: every
reason an arrow was left undecided, how many wrong and true claims it holds,
which words and languages, and whether anybody could do anything about it —

- **now** — the fact is in the code and a reader stopped short of it.
- **work** — it needs a type, a crate-wide index, a language server, or the
  measurement that licenses a word to accuse.
- **never** — the text does not say. A callback, a macro, a name built at run
  time, an end the board put outside the repository.

The labels live in `scripts/lib/undecided-buckets.ts`, one line of reasoning
each, and `tests/bench-planted.test.ts` fails if a refusal word the engine can
produce has no entry — an unlabelled reason would silently count as hopeless and
lower the ceiling by exactly the work nobody did.

From that the run prints **the score this project is judged by** — a wrong claim
went red, a true claim went green — beside what it would be if every fixable
claim were decided, and a worklist of the fixable reasons ranked by claims per
unit of work.

## What is stored

| | |
| --- | --- |
| `scopes.json` | the 45 boards to draw: project, language, a scope, and what the board is about |
| `boards/<project>/<topic>.excalidraw` | the board, drawn by Haiku against the pinned clone |
| `boards/<project>/<topic>.answers.json` | every claim scored on that board, and what the tooling said about it |

Each answer file records the commit it describes (`pin`) and the tool that
answered (`tool`). The clones live in `.corpus`, pinned by `src/engine/licence.ts`.

## Where each part comes from

**The boards come from Haiku**, one run per row of `scopes.json`, isolated from
any installed plugin:

```
npm run build:cli
sh scripts/bench-planted-draw.sh 0        # the first row; 0..44
```

Haiku surveys the scope, names the boxes, picks the flow and writes the claims.
45 boards cost about $8. Two things it did that are worth knowing when reading
the score: some boards came back with qualified refs
(`dispatcher.py#Signal.connect`), which the skill forbids and every reader
refuses, and a few runs drew nothing at all and had to be run again.

**The answers come from the language tooling, never from `src/engine`:**
rust-analyzer, pyright and the TypeScript compiler, asked through
`scripts/lib/bench-tooling.ts`. `scripts/lib/bench-oracle.ts` turns their
answers into true / false / **undecidable**, and `tests/bench-planted.test.ts`
fails if any of those files ever imports the engine. That import is the whole
point: a benchmark whose answer key is the checker measures whether the checker
agrees with itself.

**Undecidable is a real answer and it is counted.** A claim whose truth the
tool could not establish — an unresolved import, a name that could mean two
declarations, a member read through `getattr` — leaves the score with its
reason. Guessing there would turn correct silence into a miss.

**The mistakes come from a script**, `scripts/bench-planted-key.mts`, four per
claim the tooling called true, exactly as #296 asks:

- the claim word swapped for another the two ends could carry,
- the arrow reversed,
- an end moved to a different real symbol in the same file,
- an end moved to a symbol of the wrong kind (a struct with `@feeds`).

A mutation only counts as a planted mistake once the tooling has called the
result false. A reversed arrow between two routines that call each other both
ways is still true, and scoring it as a miss would be scoring the generator's
assumption.

Beside the planted ones the key keeps two more kinds of claim: what Haiku
actually drew (some of it wrong, which is a mistake nobody had to plant), and
every other word tried on the same arrow and kept when the tooling said it was
true. The second is where most of the *true* claims come from, and true claims
are what a false red is measured against.

## Rebuilding the key

```
npx tsx scripts/bench-planted-key.mts              # every board, slow
npx tsx scripts/bench-planted-key.mts anyhow       # one project
```

Needs `rust-analyzer` on the machine; pyright is fetched by `npx`. The result
is deterministic given the same clones at the same pins: the plants are chosen
by a hash of the claim, not at random.

### Correcting how one word is judged, without moving the population

A rebuild grows plants from every claim the tooling calls true, so changing how
a word is judged and then rebuilding changes *which* claims are scored, not
only their answers. To correct the answers alone, re-ask the stored claims in
place:

```
npx tsx scripts/bench-planted-rejudge.mts --word=calls --why="the from end is a type"          # dry run
npx tsx scripts/bench-planted-rejudge.mts --word=calls --why="the from end is a type" --write
```

`--why` narrows it to claims whose stored reason starts with that text. #346
used exactly the line above: an `@calls` arrow out of a class had been called
false outright, and is now read through the class's own routines.
