# iface.py: for every missed arrow blocked by an interface/trait/Protocol or overridden call, which method names
# those calls name (last pass, in the tail's routine(s)), and whether any is the head's own name.
import json, collections, re
T = "/Users/noelmatero/bench-map2/trace"
A = json.load(open(f"{T}/arrows.json"))
out = []
for s in ["main", "holdout", "holdout-b"]:
    calls = collections.defaultdict(list); mp = collections.defaultdict(int)
    for l in open(f"{T}/walls-{s}.jsonl"):
        w = json.loads(l)
        if w.get("stage"): continue
        aid = int(str(w["arrow"]).split("|")[0]); mp[aid] = max(mp[aid], w.get("pass") or 0); calls[aid].append(w)
    for a in A:
        if a["set"] != s: continue
        ps = set(a["patterns"])
        if not ps & {"interface / trait / Protocol call", "overridden method"}: continue
        tfile = a["from"].split("#")[0]
        head = re.split(r"\.|::", a["to"].split("#")[-1])[-1]
        last = [w for w in calls[a["id"]] if w["pass"] == mp[a["id"]] and w["file"] == tfile and w["why"] in ("abstract-receiver", "overridden")]
        names = sorted({w["callee"] for w in last})
        rest = sorted(ps - {"interface / trait / Protocol call", "overridden method"})
        out.append({"set": s, "id": a["id"], "lang": a["lang"], "head": head, "names": names, "same": head in names, "alone": not rest, "rest": rest, "from": a["from"], "to": a["to"], "source": a["source"]})
json.dump(out, open("iface.json", "w"), indent=0)
c = collections.Counter((o["set"], o["same"], o["alone"]) for o in out)
for k in sorted(c): print(k, c[k])
for o in out:
    if o["alone"]: print(o["set"], o["id"], o["lang"], "SAME" if o["same"] else "diff", o["head"], o["names"][:8], o["source"])
