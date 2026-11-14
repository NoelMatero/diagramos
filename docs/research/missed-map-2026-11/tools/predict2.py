# predict2.py: the #466 map model, corrected against #468's measured result (2026-10-19).
# 1. Credit an issue only with the shapes its PR builds. Box names with # or $ and a box function the
#    parser loses are found by the endpoint lookup, not the call-site lookup; no layer-1 issue builds them.
# 2. The map's labels are text patterns. Read against source, 8 of 12 arrows #468 should have flipped were
#    labelled right and built; 7 of those 8 then survived the compiler gate. Per-arrow yield 7/12 = 0.58.
# 3. A route note (the tail reaches the head in steps) flips red when the route ran through a wrong
#    placement the issue removes: 4 of 11 on main for #468, 0 of 9 on the holdouts. Wrong placements are
#    50 now (were 1,329), so later issues get ~0 from this.
# 4. Fixing a misread can expose a harder doubt behind it (rich: an interface call) and lose a red:
#    1 in 3 sets for #468.
# Replay: reproduces #468's +4 / +2 / +4 calls on main / holdout / holdout-b. Re-predicts #469-#471 from the
# post-#468 map (~/bench-why-468/remap/arrows.json, the same pipeline over today's main).
import json, collections, sys
OLD = json.load(open("/Users/noelmatero/bench-map-calls/arrows.json"))
NEW = json.load(open("/Users/noelmatero/bench-why-468/remap/arrows.json"))
SETS = ["main", "holdout", "holdout-b"]
NEVER = "untyped value, compiler never asked"
Q = {"ts": 0.84, "python": 0.57, "rust": 0.52}
HC_MISSED = 146
YIELD = (7 / 12, 0.35, 0.80)  # centre, low, high (12 arrows; wide on purpose)

ENDPOINT = {"TS #private name written without #", "a name with $ in it", "a plain function reported not declared", "an end not found"}
BUILT = {
    468: {"built-in read as a local", "built-in hidden by a wildcard import", "TS host global not known", "re-export not followed",
          "name declared twice", "inherited method on self", "a name declared nowhere visible", "Rust Type::fn path not placed"},
    469: {"library import not placed", "untyped value: method the repo never declares"},
    470: {"call shape misread", "a method named call read as dynamic"},
    471: {"inside a Rust macro", "a Rust macro it doesn't follow", "the head's name inside a Rust macro"},
}
# What reading the source showed the map got wrong for #468's arrows (set, id) -> patterns that really block.
RELABEL = {
    ("holdout-b", 287): {"library import not placed"},          # isStringLiteral: util.ts -> vendor-core.ts -> zurk/spawn, a library
    ("holdout-b", 804): {"local holding a function"},           # rayon `if let Some(ref handler) = registry.start_handler`
    ("holdout-b", 689): {"wildcard from a module with __all__"}, # trio: #468 reads such a wildcard as unknown, on purpose
    ("holdout-b", 714): {"wildcard from a module with __all__"},
}

def blockers(a, relabel=True):
    b = set(a["patterns"]) - {NEVER}
    if relabel and (a["set"], a["id"]) in RELABEL: b = (b - BUILT[468]) | RELABEL[(a["set"], a["id"])]
    return b

def win(a, fixed, relabel=True):
    b = blockers(a, relabel)
    if not b or not b <= fixed: return 0.0
    return Q[a["lang"]] if NEVER in a["patterns"] else 1.0

def wins(arrows, fixed, relabel=True):
    return {s: sum(win(a, fixed, relabel) for a in arrows if a["set"] == s) for s in SETS}

def route_flips(arrows, issue):
    # measured for #468 only; later issues remove at most a handful of the 50 wrong placements left
    return {"main": 4, "holdout": 0, "holdout-b": 0} if issue == 468 else {s: 0 for s in SETS}

f = lambda d: " · ".join(f"{d[s]:+.1f}" for s in SETS)
print("== replay #468 on the old map (blockers before #473)")
old_model = wins(OLD, BUILT[468] | ENDPOINT, relabel=False)
print("  old model, endpoint shapes credited, labels as mapped:", f(old_model))
built = wins(OLD, BUILT[468])
print("  built shapes only, labels corrected:                 ", f(built))
gate = {s: built[s] * 7 / 8 for s in SETS}
replay = {s: gate[s] + route_flips(OLD, 468)[s] - (1 if s == "holdout" else 0) for s in SETS}
print("  x gate 7/8, + route notes, - exposed doubts:          ", f(replay))
print("  measured (calls arrows):                              ", f({"main": 4, "holdout": 2, "holdout-b": 4}))

print("\n== re-predict on the post-#468 map (today's main), gain over today's main")
missed = {s: sum(1 for a in NEW if a["set"] == s) for s in SETS}
print("  missed wrong @calls arrows now:", missed)
fixed = set()
cum = {s: [0.0, 0.0, 0.0] for s in SETS}; hc_cum = [0.0, 0.0]
for issue in (469, 470, 471):
    fixed |= BUILT[issue]
    raw = wins(NEW, fixed, relabel=False)
    alone = wins(NEW, BUILT[issue], relabel=False)
    c, lo, hi = YIELD
    mid = {s: raw[s] * c for s in SETS}
    low = {s: max(0.0, raw[s] * lo - 1) for s in SETS}
    high = {s: raw[s] * hi for s in SETS}
    rate = [mid[s] / missed[s] for s in ("holdout", "holdout-b")]
    rlo = [low[s] / missed[s] for s in ("holdout", "holdout-b")]; rhi = [high[s] / missed[s] for s in ("holdout", "holdout-b")]
    print(f"  #{issue} cumulative over today's main: raw {f(raw)}  |  range " + " · ".join(f"+{low[s]:.0f}-{high[s]:.0f}" for s in SETS)
          + f"  (centre {f(mid)})  holdout-c +0-{max(rhi) * HC_MISSED:.0f}")
    print(f"        this issue alone (raw): {f(alone)}")
touch = lambda P: {s: sum(1 for a in NEW if a["set"] == s and blockers(a, False) & P) for s in SETS}
print("\n  arrows each issue touches now:", {i: touch(BUILT[i]) for i in (469, 470, 471)})
print("  left over from #468 (not built):",
      {"box names (#, $, parser)": touch(ENDPOINT), "wildcard built-ins": touch({"built-in hidden by a wildcard import"}),
       "Type::fn": touch({"Rust Type::fn path not placed"}), "re-export": touch({"re-export not followed"})})
print("  endpoint shapes alone (raw, body never read so blockers unknown):", f(wins(NEW, ENDPOINT, relabel=False)))
