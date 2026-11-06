# Holdout B

A second sample of code nobody has tuned the checker on: the same test, the
same machinery and the same rule as [`bench-holdout/`](../bench-holdout/README.md).
**Read the score, never the arrows.** Only a correct arrow called wrong or a
wrong arrow confirmed is read, and only to tell a broken key from a broken
checker.

```
npm run bench:libraries -- --set=holdout-b   # clones in ~/.board-ai-holdout-b/, then libraries
npm run bench:planted -- --set=holdout-b     # the score
```

## The projects

Chosen 2026-10-06 from a list disjoint from holdout and holdout-c: popular and
active, a spread of sizes and styles per language, each pinned to the head of
its default branch that day. 39 boards, three per project.

| language | project | kind | why |
| --- | --- | --- | --- |
| TypeScript | drizzle-orm | ORM, large monorepo | query builders typed through deep generics, a dialect class per database, thin driver sessions |
| | immer | library, small | Proxy traps, plugins looked up by name, recursive finalisation; no dependencies |
| | zx | CLI and library, small | a promise subclass that runs a child process; Node APIs everywhere |
| | Elysia | web framework, medium | route handlers compiled from generated source text, an adapter per runtime |
| | MobX | library, medium | reactive state through global mutable state and administration objects behind proxies |
| Python | Django REST framework | web framework, large | the untyped-ish one: no annotations, mixins, `getattr` and settings |
| | Black | CLI, medium | typed; a visitor over a parse tree and a pipeline of line transformers |
| | Trio | async-heavy, large | its own event loop, generated wrappers around one run-state object |
| | marshmallow | library, small | a metaclass collecting fields, hooks registered by decorator |
| Rust | actix-web | web framework, large workspace | service factories and extractors through traits |
| | bat | CLI, medium | library and binary in one crate, a printer trait with two implementations |
| | rayon | library, medium | producer and consumer traits, a work-stealing thread pool |
| | reqwest | async client, medium | builders, futures polled by hand, much of it feature-gated |

## Choices that matter

- **Features.** `actix-http`'s default features are empty, as hyper's were in
  holdout, so its code is switched off for rust-analyzer; the actix boards stay
  in `actix-web` and `actix-router`. reqwest's boards stay in the async client
  and the code its default features switch on (`blocking`, `json` and
  `cookies` are off).
- **Installs.** immer and the `mobx` package have no dependencies, so no
  install. Elysia is installed with bun (`npx bun@1.3.4`), drizzle with pnpm
  filtered to `drizzle-orm...`, zx with `npm ci`.
- **marshmallow** has no libraries on Python 3.14: both its dependencies are
  for Python older than 3.11, so its pin file is empty.

## Two projects crash the checker

At 09724c0, `bench:planted --set=holdout-b` stops on two projects, and so
does `--project=` for either one alone. Both are the checker's own crash, not
the set's: a tree from the shared parse cache is freed while it is still being
walked, because the walk parses enough other files to push it out.

- **actix-web**: `readRustDependencies` follows re-exports through
  `reexportsOf`, which parses each file through the cache (`TypeError: Cannot
  read properties of null (reading 'type')`, `deps-rust.ts:138`).
- **MobX**: `callSitesIn` walks a file while `textClosed`'s reading parses
  others (`RuntimeError: memory access out of bounds`, `calls.ts:3441`).

Until that is fixed, the set is scored with those two projects' boards moved
aside: 33 of 39 boards.
