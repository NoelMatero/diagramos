# Reading the code myself: five boards, and where the tooling was wrong

#296 asks for a person-level check, because an answer key nobody has read is
an assumption with a JSON file around it. Five boards were taken and every
claim the tooling **decided** (true or false) was read against the source at
the pinned commit. Undecidable claims were read too, but they leave the score
either way, so a wrong one costs coverage rather than correctness.

| board | language | decided claims read |
| --- | --- | ---: |
| `anyhow/error-construction` | Rust | 34 |
| `ripgrep/globset` | Rust | 46 |
| `encode-httpx/client-send` | Python | 52 |
| `TanStack-query/query-observer` | TypeScript | 32 |
| `excalidraw-excalidraw/dropdown-menu` | TSX | 47 |

## Two answers were wrong, both in Rust, both now fixed

**1. A return type read as a construction.** `impl GlobMatcher { pub fn
glob(&self) -> &Glob { .. } }` made the key say GlobMatcher *builds* a Glob.
The reader was looking for `Name {`, which is a struct literal — and is also
what a return type followed by the body's own brace looks like. Found by
reading the reverse plant of `Glob --@builds--> GlobMatcher` and not believing
it. `constructionAt` now refuses a name in type position, and the claim is
undecidable ("named here but not plainly constructed"), which is the honest
answer: the accessor mentions the type and makes nothing.

**2. Every impl block between the first and the last, counted as one.** A Rust
type's `impl` blocks were read as a single span from the first to the last,
which swallows whatever other types' impls sit in between and credits their
constructions to this type. Fixed to read each block on its own.

Both were in the answer key, not in the checker. Both would have scored the
checker's correct silence as a miss.

## Two answers are imprecise rather than wrong

**A name that means two declarations gets one declaration's reason.** In
`anyhow`, `src/error.rs#vtable` is both a field of `ErrorImpl` and a free
function, and `src/error.rs#object_drop` is both a vtable field and a generic
function. The key gives the right verdict (false either way) with a reason
that names only one of them: "the to end is a value or field". Where the two
readings would *disagree*, the claim is undecidable and says so ("the ref
could mean more than one declaration, and they differ") — 21 claims across
the set.

**Calling a method of a class is not calling the class.** `_send_handling_auth
--@calls--> Auth` is false in the key: nothing in that routine calls `Auth`,
it calls `auth.async_auth_flow(...)` on an instance. That is the word read
strictly, and it is the reading `claims.md` gives; a board meaning "this
routine drives the auth object" has written the arrow at the wrong altitude.
Worth knowing when reading the score, because the checker stays quiet there
and the key counts a quiet as a miss.

## One disagreement that is a dispute about the word, not a bug

**A class at the tail of `@calls`.** Haiku drew `Request --@calls--> URL` and
`Injector --@calls--> loadProvider`, with a class at the `from` end. The key
calls those false: `claims.md` says `@calls` runs between two things that run,
and a class does not call anything -- its methods do. The checker reads the
class body and confirms. Neither is a mistake exactly; the arrow is drawn one
level too high and the two of them read the word differently. It accounts for
about a dozen of the greens in the score, and it is the reason the FALSE
CLAIMS table separates what Haiku drew from what the script planted.

## What the reading confirmed

- Every `needs` answer checked out, in all three languages, including the
  awkward ones: `lib.rs` and `glob.rs` in globset import each other, so the
  reversed arrow is genuinely true and was dropped from the plants rather than
  counted as a mistake the checker missed.
- The wrapper rule holds: `branches: Vec<Tokens>` is `Parser` holding
  `Tokens`, and the key says so.
- Haiku's own claims are a mixed bag worth having. On the httpx board it drew
  `send --@takes--> Request` (backwards: `takes` runs type → function) and
  `BaseTransport --@returns--> Response` (anchored at the class, not at
  `handle_request`). Both are false, neither was planted.
- Three of the five boards contain refs the skill forbids
  (`dispatcher.py#Signal.connect`), and every reader refuses those, so those
  arrows are undecidable rather than scored. 32 claims across the whole set.

## What the score's false reds turned out to be

Read back the other way -- eight true claims the checker called wrong -- seven
have one cause, in two languages: **the field reader only sees fields written
in the body of a declaration**. It misses a TypeScript constructor parameter
property (`constructor(public dep: Dep)` in vue's `Link`, `private readonly
routePathFactory: RoutePathFactory` in nest's `RouterExplorer`) and a Python
attribute annotated in `__init__` (`self._request: Request | None = request`
in httpx's `Response`, `self._assignments: list[Assignment] = []` in poetry's
`PartialSolution`, `self.tags: dict[str, JSONTag] = {}` in flask's
`TaggedJSONSerializer`). Each was read in the source at the pinned commit and
each is a real field.

The eighth is `@needs` in clap: `debug_asserts.rs` writes `use crate::{Arg,
Command, ValueHint}` and `command.rs` writes `use
crate::builder::debug_asserts::assert_app`, so the two files import each
other -- and the check called the arrow backwards rather than withholding on
the cycle, because the first direction reaches `command.rs` through the crate
root's re-export.

## The scoring method was checked too

Each claim is scored on a board of its own, two boxes and one arrow. To know
that this does not change the verdict, every claim Haiku drew on these five
boards was run both ways — on the whole board and alone. 60 of 62 agreed. The
two that did not were arrows into a box Haiku had marked `external`, whose
state the scorer was dropping; it now carries `state` through, and they agree.
