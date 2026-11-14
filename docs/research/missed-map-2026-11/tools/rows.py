# rows.py: every false claim the checker did not catch (not red), per set, ids = line index in the dump.
import json
O = "/Users/noelmatero/bench-map2"
for s in ["main", "holdout", "holdout-b"]:
    rows = []
    for i, l in enumerate(open(f"{O}/score/{s}.jsonl")):
        r = json.loads(l)
        if r["truth"] == "false" and r["outcome"] != "red":
            rows.append({"id": i, "project": r["project"], "topic": r["topic"], "cid": r["cid"], "word": r["word"], "frm": r["from"], "to": r["to"]})
    json.dump(rows, open(f"{O}/trace/rows-{s}.json", "w"))
    print(s, len(rows))
