# summary.py: per set, caught % of false claims, gap to 80%, missed by word and by word x reason.
import json, collections, sys
SC = "/Users/noelmatero/bench-map2/score"
sets = sys.argv[1:] or ["main", "holdout", "holdout-b"]
for s in sets:
    D = [json.loads(l) for l in open(f"{SC}/{s}.jsonl")]
    F = [d for d in D if d["truth"] == "false"]
    red = sum(d["outcome"] == "red" for d in F)
    need = -(-len(F) * 80 // 100)
    print(f"== {s}: false {len(F)} red {red} ({100*red/len(F):.1f}%), 80% = {need}, gap {need-red}; true reds {sum(d['truth']=='true' and d['outcome']=='red' for d in D)}")
    miss = [d for d in F if d["outcome"] != "red"]
    w = collections.Counter(d["word"] for d in miss)
    print("   missed by word:", dict(w.most_common()))
    print("   missed by lang:", dict(collections.Counter(d["language"].replace("tsx","ts") for d in miss).most_common()))
    wr = collections.Counter((d["word"], d["reason"]) for d in miss)
    for (word, r), n in wr.most_common(60): print(f"   {n:4} {word:9} {r}")
