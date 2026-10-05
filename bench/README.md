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

It calls no model. It does start language servers -- rust-analyzer and
pyright, the checker's own second opinion since #328 and #337 -- and builds
Rust crates for the compiler's call lists (#357), so the score is the check a
person actually gets.

**A full run takes 6-7 minutes and exits by itself** (2026-10-01, 1,264
claims, 15 projects; the same with the Rust build cache empty). Each project's
servers are closed when the run moves to the next. If a run takes much longer,
look at the machine before the code: on 2026-09-29 the same commit took
5 h 50 m, every arrow about fifty times slower than normal, while something
else had the machine (#403).

It waits before starting while another `bench:planted`, `measure-*` script or
vitest is running, and says which; two at once starve the language servers and
make reds that have nothing to do with the change. `--no-wait` skips that.

What one arrow costs, asked twice:

```
npm run probe:check-cost                   # cold, and through a held cache
```

## Keeping a run, and comparing two (#403)

A run worth keeping goes into a folder, one process per project:

```
npm run bench:planted:runs -- ~/runs/base                  # on main
npm run bench:planted:runs -- ~/runs/arm                   # on the branch, from its own worktree
npm run bench:planted:compare -- ~/runs/base ~/runs/arm
```

- **Resumable.** Each finished project is `<folder>/<project>.txt`. Run the same
  command again and only the missing ones run. A folder remembers its commit
  and flags and will not be finished by another.
- **Capped.** `--cap=<seconds>` (default 900) per project; a project over it is
  stopped, language servers included, and named at the end.
- **Narrowed** with `--projects=regex,ripgrep`; any other flag
  (`--word=calls`, `--language=rust`) is passed to every project.

`bench:planted:compare` reads folders or the saved output of one
`npm run bench:planted -- --details`, in any mix. It prints both sets of totals
and every arrow whose answer flipped, with what each side said, and counts the
arrows whose answer held but whose reason changed (`--all` lists those). It
exits 1 when anything differs.

Run both arms on the same day's main, one after the other: a baseline from the
morning is not comparable with an afternoon arm, because main moves several
times a day.

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

## The projects' own libraries (#429)

```
npm run bench:libraries                    # once per machine; again when a pin changes
```

A user's checkout has its libraries installed; a bare clone does not. Without
them pyright cannot say what Flask's `request_started.send(...)` is (blinker),
and the TypeScript compiler cannot type anything React returns in TanStack, so
the check, and the answer key, stop on calls a user's machine would answer.

`bench:libraries` installs them beside `.corpus`, in `.corpus-libs/`, and never
in it:

- **The five Python projects** each get a venv at
  `.corpus-libs/python/<project>/`, holding the project's dependencies and
  extras (never its test or lint tools, never the project itself) at the
  versions in `bench/libraries/<project>.txt`. Each file says where its pins
  came from: the project's own `uv.lock` or `poetry.lock` at the pinned commit,
  or, for the two with no lock (Django, httpx), the versions current on the
  day of that commit. Python 3.14 for all five.
- **TanStack** gets a checkout of its pin at `.corpus-libs/corpus/TanStack-query`,
  with `pnpm install --frozen-lockfile` run in it at the pnpm version its
  `package.json` names, for `@tanstack/react-query` and what it depends on
  (every TanStack ref is in `query-core` or `react-query`).

Needs `uv`, `git` and the network; about four minutes the first time, most of
it pnpm. `.corpus-libs/installed.json` records what was installed from which
pins, and the script does nothing when that still matches.

Every bench script that reads a corpus project -- `bench:planted`, the key
builder, the re-judge -- reads it with its libraries when they are installed:
that project's venv goes first on `PATH`, where pyright looks for an
interpreter, and TanStack is read from its own checkout. The score's header
says which it was:

```
  libraries: installed from pins a0e7e56d41 (6 projects, /Users/noelmatero/board-ai/.corpus-libs)
```

A run without them says `not installed` there, and its Python and TanStack
numbers are not comparable with one that had them. `BENCH_LIBRARIES=<folder>`
points the scripts at another folder; a folder with nothing in it is a run
without libraries.

Excalidraw, the other TypeScript project with no `node_modules` in `.corpus`,
is not covered yet.

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

`--project` runs one project at a time. #374 re-asked every `@calls` and
`@accesses` claim that way, project by project, because one language server
dying (regex's, on `@builds`, on unchanged main too) ends the whole run:

```
npx tsx scripts/bench-planted-rejudge.mts --word=calls --project=anyhow --write
```

`--project` also takes a comma list, and `--word=all` re-asks every word: what
a change to the machine rather than to one word needs. #429 installed the
projects' libraries and re-asked the six projects they touch, after a control
with the libraries switched off (`BENCH_LIBRARIES` set to an empty folder):

```
npx tsx scripts/bench-planted-rejudge.mts --word=all \
  --project=django-django,encode-httpx,pallets-flask,pydantic-pydantic,python-poetry-poetry,TanStack-query --write
```

A class at the far end of `@calls` is now called when the tail creates one
(`new B()`, `B()`, `B::new()`, `B { .. }`, a subclass) or calls anything it
declares; a class at the tail of `@accesses` reads the member when one of its
routines does. A getter or a `@property` read is not a call.
