# Why the checker still misses wrong arrows (map of 2026-11-08)

The checker catches 81% of the wrong arrows on the set it was built against, but only 63–66% on code it has never seen. This map traces every wrong arrow it still misses on three of the four benchmark sets, and groups the misses by what blocks them. It ranks the groups by how many catches fixing each would add. The goal is about 80% caught on the held-out sets.

The headline: **the checker alone cannot get there.** The five biggest patterns together should reach about 75–80% on holdout and 70–76% on holdout-b. One of the five is a decision about what an arrow means, not a bug. Without it, no combination of checker fixes gets a held-out set to 80%.

## Where each set stands

Main d0f2b62, answer keys after #465. Every run had the machine to itself.

| set | caught | needed for 80% | short by |
|---|---|---|---|
| main | 667 / 821 (81%) | 657 | already over by 10 |
| holdout | 434 / 654 (66%) | 524 | 90 |
| holdout-b | 403 / 637 (63%) | 510 | 107 |
| holdout-c (score only) | 479 / 743 (64%) | 595 | 116 |

- **What was traced:** every missed wrong arrow, 154 on main, 220 on holdout and 234 on holdout-b. Each trace matched the benchmark's own verdict exactly.
- **holdout-c was scored only.** No arrow of it was printed, read or classified.

## The patterns, ranked

"Alone" counts the arrows where this pattern is the only thing blocking a catch. "Any" counts every arrow it blocks, alone or together with other patterns.

Predictions apply the one-third overshoot correction from the October map: the model has overstated measured gains by about a third.

| # | pattern | alone (main / holdout / holdout-b) | predicted catches | existing issue |
|---|---|---|---|---|
| 1 | The checker already finds the real route ("reaches it in 2 steps, through X") but only shows it as a note | 29 / 27 / 18 | +29 / +27–28 / +18–19, exact | none; reverses #375 |
| 2 | The end is plainly the wrong kind, and the code text already shows it, but an earlier step hides it | 7 / 15 / 15 | +4–7 / +9–15 / +9–15 | #463 (widened), #453 |
| 3 | The end is data where the arrow needs something that runs, which only a compiler can tell | 41 / 42 / 50 | +14–33 / +15–34 / +18–40 | #463 family; none for value ends or @feeds |
| 4 | An arrow drawn from a class or struct is never checked | 2 / 10 / 11 (any: 10 / 23 / 37) | +1–2 / +4–9 / +4–9 | #459 |
| 5 | A call through an interface, trait, Protocol or overridden method keeps the whole function open | 5 / 13 / 8 (any: 14 / 30 / 17) | +2–4 / +5–10 / +3–7 | #351, #461 |

**Patterns 1–5 together:**
- main about 89%;
- holdout 75–80% (about 490–525 caught);
- holdout-b 70–76% (about 445–485 caught);
- holdout-c by the same shares 72–77%, which is +55 to +90. The rules require the range to start at +0, since nobody looks at holdout-c.

**Raw ceiling:** with every blocker on those arrows fixed, +86 / +113 / +107.

### 1. The route is found but not used

When an arrow says "A calls B" and A reaches B only through X, the checker already works out the route and prints it. It still answers "not sure" instead of "wrong".

- **On the benchmark:** this happens on 29 / 28 / 19 wrong arrows in the three sets, and on zero correct arrows (checked against the per-claim dumps in `data/`).
- **Which arrows:** about half are @needs and half are @calls.
- **By language** (arrows blocked alone): Python 55, TypeScript 10, Rust 9. Python dominates because of @needs arrows that hold only through a chain of imports.

**Decision (user, 2026-11-08):**
- **First,** a plain arrow means direct. An indirect one goes red, and the message shows the hops: "A doesn't call B directly; it gets there in 2 hops: A → X → B". It offers two fixes: draw X in, or mark the arrow as indirect.
- **Later,** an indirect arrow kind. It is green when the route exists, and the board shows "via X · 2 hops".

### 2. Wrong kind, visible in the text (37 arrows)

For example, a function where a type is needed, or a method used as a base class. The part reader already says the end lacks what the word needs. Something earlier hides that answer:

| what hides it | arrows |
|---|---|
| a red the compiler couldn't back is withdrawn | 14 |
| the box is marked external on the board | 11 |
| nothing is recorded | 9 |
| a wrong confirmation | 2 |
| a file that didn't parse fully | 1 |

The false-red risk is low, because those part readings already have a measured licence.

### 3. A data end where something must run (133 arrows, the biggest)

Examples are an @calls arrow onto a field, a constant or a local; an @feeds arrow onto a type; an @accesses arrow onto a field. Each of these arrows is blocked by this alone. Two gaps cause it:

- **The text reader answers "not sure" for values.** For 29 of them it can't even find the name; these are Python attributes and locals.
- **@feeds has no rule that its far end must run** (14 arrows).

The compiler answers about 84% of the time for TypeScript and 57% for Python. Rust isn't asked at all. That is why this pattern's range is so wide.

### 4. Arrows drawn from a class (#459)

It came out smaller than October's estimate of 146 arrows suggested; much of that has since been fixed or now hits another blocker first.

In a smoke test on 7 arrows drawn from a class:
- the Python ones (fastapi, requests) went red;
- TypeScript "classes" written as an interface plus a constant (zod) stay unread.

### 5. Dispatched calls (#351)

In 76 of the 78 interface, trait or override calls, the method name differs from the arrow's far end.

- **The rule:** a dispatched call runs a routine with its own name, so it can't directly be a routine with a different name.
- **The risk:** a function stored under another name, such as an options object `{ onError: handler }`.
- **The smoke test** turned bullmq's `handleCompleted` and `handleFailed`, and pip's arrows, red.

## Not worth a fix of its own

- **The type-alias lead.** All 10 such misses are on main (excalidraw's math types); there are 0 on holdout and holdout-b.
- **Run-time function values** (callbacks, locals and fields holding functions): 4 / 9 / 11 blocked alone. #461 already measured +2 / +6 / +3, with blind spots that cause false reds.
- **Values whose type nothing resolved:** mostly a second blocker (1 / 1 / 8 alone).
- **Dynamic code** (getattr, eval, star imports): 10 / 5 / 7 alone. 17 of holdout-b's are in trio, where Python's `__all__` rule for star imports would be exact.
- **Rust macros and `Type::fn` paths:** 0 / 5 / 4 alone.
- **@builds absences, mostly Python:** 8 / 14 / 11. This looks like a licence that was never measured.
- **Other @needs misses:** 1 / 13 / 11. Six of them are wrong arrows the checker confirms, which may be answer-key errors.

## Every pattern group

Produced by `tools/model.py`.

```
group             any  alone   alone main/holdout/holdout-b    any main/holdout/holdout-b   by lang (alone)
kind-compiler     133    133   41/42/50                    41/42/50                    ts 56, rust 22, python 55
route              96     74   29/27/18                    37/38/21                    python 55, ts 10, rust 9
untyped            94     10   1/1/8                       22/32/40                    python 4, ts 4, rust 2
funcval            72     24   4/9/11                      16/33/23                    python 8, ts 11, rust 5
class              70     23   2/10/11                     10/23/37                    python 7, ts 12, rust 4
dispatch           61     26   5/13/8                      14/30/17                    python 8, rust 6, ts 12
dynamic            42     22   10/5/7                      12/6/24                     python 14, ts 4, rust 4
kind-text          37     37   7/15/15                     7/15/15                     ts 29, python 6, rust 2
builds-other       33     33   8/14/11                     8/14/11                     ts 10, python 20, rust 3
rust               32      9   0/5/4                       4/14/14                     rust 9
names              29      4   1/0/3                       10/8/11                     python 1, ts 1, rust 2
typehead           29     23   12/5/6                      14/8/7                      ts 18, rust 2, python 3
nevernamed         28      2   0/1/1                       3/12/13                     python 2
needs-other        25     25   1/13/11                     1/13/11                     ts 17, python 8
accesses-other      9      9   0/6/3                       0/6/3                       python 2, ts 4, rust 3
returns-other       7      7   4/0/3                       4/0/3                       rust 2, ts 4, python 1
holds-other         7      7   0/2/5                       0/2/5                       ts 2, rust 2, python 3
conforms-other      5      5   0/1/4                       0/1/4                       ts 5
other               4      1   0/1/0                       1/2/1                       python 1
takes-other         3      3   0/0/3                       0/0/3                       ts 3
missed per set: main 154, holdout 220, holdout-b 234
```

## Still to come: measured prices

Patterns 2–5 are being priced by switching each wall off in a throwaway worktree and benching main, holdout and holdout-b, never holdout-c. The arms are kind-first with the compiler asked for values, the interface name rule, class tails, all three together, and interface plus the name rule for untyped receivers. Those numbers replace the predictions above when they land. A wall-lift is an upper bound, not the guarded rule.

## Files

**`data/`**

| file | what it holds |
|---|---|
| `verdicts-<set>.jsonl.gz` | every claim's verdict and reason, for main, holdout and holdout-b |
| `missed-all.json` | every missed wrong claim, all words (608) |
| `arrows.json` | the blocking patterns for each missed @calls arrow |
| `kindprobe.json` | the part reading of each wrong-kind end |
| `iface.json` | method names of the dispatched calls |
| `model.json` | the pattern groups and the cumulative table |
| `class-*.json`, `smoke*.json` | class-tail and smoke-test results |
| `holdout-c-score.txt` | holdout-c's score, with no arrows |

**`tools/`**
- The October map pipeline, updated: `trace.mts`, `classify.mts`, `aggregate.py`, `predict2.py`, `rows.py`, `summary.py`, `tailkind.mts`.
- `model.py`, `family.py`, `iface.py` and `kindprobe.mts`.
- `dump.patch`, the bench patch that writes the per-claim dumps.

The tools hold absolute paths to `~/bench-map2` and `~/board-ai-map2`, where they ran. They are kept as a record, not wired into the repo.
