# family.py: every missed wrong claim (all words) by what the key says is wrong with it, per set and language.
import json, collections, re
SC = "/Users/noelmatero/bench-map2/score"
def fam(d):
    w, y = d["word"], d["why"]
    if re.match(r"the (to|from) end is (a|an) ", y): return "wrong kind of end"
    if w == "calls" and y.startswith("the routine's calls were read"): return "calls: routine tail, no such call"
    if w == "calls" and (y.startswith("every routine of the type") or y.startswith("the type has no routine")): return "calls: class/struct tail"
    if w == "calls" and y.startswith("it neither creates one"): return "calls: class head, not made/used"
    if w == "needs": return "needs: no import"
    if w == "builds": return "builds: makes none"
    return f"{w}: {y[:45]}"
rows = []
for s in ["main", "holdout", "holdout-b"]:
    for i, l in enumerate(open(f"{SC}/{s}.jsonl")):
        d = json.loads(l)
        if d["truth"] != "false" or d["outcome"] == "red": continue
        rows.append({**d, "set": s, "id": i, "lang": d["language"].replace("tsx", "ts"), "family": fam(d)})
json.dump(rows, open("missed-all.json", "w"))
S = ["main", "holdout", "holdout-b"]
c = collections.Counter((r["family"], r["set"]) for r in rows)
fams = collections.Counter(r["family"] for r in rows)
print(f"{'family':45} " + " ".join(f"{s:>9}" for s in S))
for f, n in fams.most_common():
    print(f"{f[:45]:45} " + " ".join(f"{c[(f, s)]:9}" for s in S))
print()
for f in ["wrong kind of end"]:
    print(f, collections.Counter((r["set"], r["lang"]) for r in rows if r["family"] == f))
    print(collections.Counter((r["word"], r["reason"]) for r in rows if r["family"] == f).most_common(20))
