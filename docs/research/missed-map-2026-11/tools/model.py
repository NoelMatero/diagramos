# model.py: every missed wrong claim (all words) -> the set of pattern groups that block it; per-group counts
# (any / alone, per set and language) and cumulative "fix these groups" catches.
import json, collections, sys
AN = "/Users/noelmatero/bench-map2/analysis"; TR = "/Users/noelmatero/bench-map2/trace"
S = ["main", "holdout", "holdout-b"]
M = json.load(open(f"{AN}/missed-all.json"))
K = {(k["set"], k["id"]): k for k in json.load(open(f"{AN}/kindprobe.json"))}
CALLS = {(a["set"], a["id"]): a for a in json.load(open(f"{TR}/arrows.json"))}
G = {
 "route": {"reaches it in steps (route note)"},
 "class": {"drawn from a class or struct", "class inherits code it can't read", "starting function is a value, not a definition"},
 "dispatch": {"interface / trait / Protocol call", "overridden method", "inherited method on self"},
 "funcval": {"callback parameter", "local holding a function", "closure-captured name", "function stored in a field", "a call's result called",
             "obj[k]() lookup", "a function value made outside the routine", "a function handed to a runner", "a name set again at run time",
             "hands the head on as a value", "an expression called", "new on an expression"},
 "untyped": {"untyped value: a local", "untyped value: an expression", "untyped value: a parameter", "untyped value: a field", "untyped value, compiler never asked"},
 "nevernamed": {"untyped value: method the repo never declares"},
 "rust": {"Rust Type::fn path not placed", "inside a Rust macro", "a Rust macro it doesn't follow", "the head's name inside a Rust macro"},
 "dynamic": {"getattr / setattr", "eval / exec", "dynamic import()", "built-in hidden by a wildcard import", "wildcard import"},
 "names": {"library import not placed", "re-export not followed", "TS host global not known", "built-in read as a local", "name declared twice",
           "a name declared nowhere visible", "call shape misread"},
 "typehead": {"head is a type the tail may create", "head is a type alias", "reaches the head's file"},
 "other": {"an end marked external", "confirmed though wrong", "compiler could not say", "compiler says it calls it"},
}
P2G = {p: g for g, ps in G.items() for p in ps}
recs = []
for r in M:
    key = (r["set"], r["id"]); gs = set()
    if r["family"] == "wrong kind of end":
        k = K.get(key); gs.add("kind-text" if k and k["reading"] == "lacks" else "kind-compiler")
    elif r["reason"].startswith("advisory"): gs.add("route")  # the checker already names the route; nothing else stands
    elif r["word"] == "calls":
        a = CALLS[key]
        for p in a["patterns"]:
            if p not in P2G: print("UNMAPPED", p, file=sys.stderr)
            gs.add(P2G.get(p, "other"))
        if not gs: gs.add("other")
    elif r["reason"].startswith("advisory"): gs.add("route")
    elif r["reason"] in ("declined: dynamic",): gs.add("dynamic")
    elif r["reason"] in ("declined: macro",): gs.add("rust")
    else: gs.add(f"{r['word']}-other")
    # A wrong-kind end is caught by the kind check whatever else blocks the body: it overrides.
    recs.append({**{k: r[k] for k in ("set", "id", "lang", "word", "reason", "source", "from", "to", "project")}, "groups": sorted(gs)})
json.dump(recs, open(f"{AN}/model.json", "w"), indent=0)
def caught(rec, fixed):
    g = set(rec["groups"])
    if g & {"kind-text", "kind-compiler"}: return bool(g & fixed)
    return g <= fixed
if __name__ == "__main__":
    allg = collections.Counter(g for r in recs for g in r["groups"])
    print(f"{'group':15} {'any':>5} {'alone':>6}   alone main/holdout/holdout-b    any main/holdout/holdout-b   by lang (alone)")
    for g, n in allg.most_common():
        al = [r for r in recs if caught(r, {g})]
        anyr = [r for r in recs if g in r["groups"]]
        lang = collections.Counter(r["lang"] for r in al)
        print(f"{g:15} {n:5} {len(al):6}   " + "/".join(str(sum(r['set']==s for r in al)) for s in S).ljust(28)
              + "/".join(str(sum(r['set']==s for r in anyr)) for s in S).ljust(28) + str(dict(lang)))
    print("missed per set:", {s: sum(r["set"] == s for r in recs) for s in S})
