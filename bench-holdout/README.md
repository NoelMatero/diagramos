# The holdout test set

The same test as `bench/` — Haiku-drawn boards, an answer key from the
languages' own tooling, mistakes planted by a script — on fourteen projects
nobody has tuned the checker on. It answers one question: **does the checker do
as well on code it has never seen as on the code it was fixed against?**

## The rule

**Read the score, never the arrows.**

A session fixing the checker does not open these boards or answer keys, does
not print per-arrow output from this set, and does not use anything learned
from it to choose or shape a fix. The moment one arrow here becomes a reason
for a change, the set stops measuring unfamiliar code and becomes a second
copy of `bench/`.

The one exception is safety. A correct arrow the checker calls wrong, or a
wrong arrow it confirms, is read — only those — to tell a broken key from a
broken checker. If the checker is wrong, the fix is filed and built against a
case reproduced *outside* this set (on `bench/`, `rust-test`, or a fixture),
and the holdout is only re-run to see the score.

The scripts keep to this on their own: with `--set=holdout`, `bench:planted`
prints the score tables and the safety failures and nothing else — no arrow
list under `--details`, no undecided-by-reason table, no worklist.

## Running it

```
npm run bench:libraries -- --set=holdout    # clones at their pins, then libraries; once per machine
npm run bench:planted -- --set=holdout      # the score
```

The clones and their libraries live outside this repository, in
`~/.board-ai-holdout/` (`corpus/` and `.corpus-libs/`; `CORPUS=` moves them),
so no `measure:* .corpus/*` run can read them into a licence.

Everything else is the main set's machinery with `--set=holdout` (or
`BENCH_SET=holdout` for the draw script): `bench:planted:runs` and
`bench:planted:compare` work the same, and so does rebuilding the key.

```
npm run build:cli
BENCH_SET=holdout sh scripts/bench-planted-draw.sh 0     # draw row 0 of scopes.json with Haiku
npx tsx scripts/bench-planted-key.mts --set=holdout       # build the answer keys
```

## What is stored

| | |
| --- | --- |
| `projects.json` | the fourteen projects: repository, pinned commit, why each was chosen, and how a TypeScript one's packages are installed |
| `scopes.json` | the 40 boards to draw: project, language, a scope, and what the board is about |
| `libraries/<project>.txt` | each Python project's libraries, resolved as of its pinned commit |
| `boards/<project>/<topic>.excalidraw` | the board Haiku drew |
| `boards/<project>/<topic>.answers.json` | every claim scored on that board, and what the tooling said |

## The projects

Chosen 2026-10-06: popular and active, none in `.corpus`, a spread of sizes
and styles per language. Each is pinned to the head of its default branch that
day.

| language | project | kind | why |
| --- | --- | --- | --- |
| TypeScript | hono | web framework, medium | small typed core with routers and middleware, no runtime dependencies |
| | zod | library, large | generic-heavy validation types, the hardest kind of TypeScript to type-check; no dependencies |
| | bullmq | async-heavy, medium | a Redis job queue built on promises, events and workers |
| | npm-check-updates | CLI, small | many small function-per-file modules |
| | tRPC | RPC framework, large monorepo | builder chains and proxies typed through deep generics |
| Python | FastAPI | web framework, medium | fully typed, built on Starlette and Pydantic, decorators everywhere |
| | aiohttp | async-heavy, large | asyncio client and server, protocols and streams |
| | Rich | library, large | typed, rendering by protocol (`__rich_console__`), dispatched by duck typing |
| | requests | library, small | the untyped-ish one: almost no annotations, mixins and hooks |
| | pip | CLI, large | command classes and a resolver; every dependency vendored |
| Rust | axum | web framework, medium | trait-heavy (Handler, FromRequest, tower Service), macro-generated impls |
| | hyper | async-heavy, medium | futures polled by hand, feature-gated modules |
| | chrono | library, medium | plain data types and arithmetic, many trait impls |
| | fd | CLI, small | one binary crate, threads and channels |

## Libraries

As on the main set: each Python project gets a venv of its dependencies and
extras (never the project itself), resolved with
`uv pip compile --all-extras --exclude-newer <commit date>` so the versions are
the ones current when the pin was made. Each TypeScript project gets a
checkout of its pin with its own package manager's frozen install
(`projects.json` names the command). Rust crates are fetched by cargo, as on
the main set.
