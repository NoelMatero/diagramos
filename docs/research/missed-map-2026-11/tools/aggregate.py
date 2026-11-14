# aggregate.py: one record per missed wrong @calls arrow, with every pattern that blocks it.
import json, collections, re, os
O = "/Users/noelmatero/bench-map2/trace"
SC = "/Users/noelmatero/bench-map2/score"
SETS = ["main", "holdout", "holdout-b"]
TK = {}
for l in open("/Users/noelmatero/bench-map2/trace/tailkind.jsonl"):
    o = json.loads(l); TK[o["i"]] = o

# fine label -> pattern shown on the map
def pattern_of(label, lang, asked, why=None):
    L = label
    if L in ("built-in / prelude name misread", "a Rust enum variant or pattern name"):
        return "built-in read as a local" if why == "local-callee" else "built-in hidden by a wildcard import"
    if L.startswith("host global"): return "TS host global not known"
    if not asked and (L.startswith("untyped value") or L == "inside a Rust macro"):
        return "untyped value, compiler never asked"
    if L.startswith("untyped value") and "nowhere in the repo" in L: return "untyped value: method the repo never declares"
    if L.startswith("untyped value: a field"): return "untyped value: a field"
    if L.startswith("untyped value: a parameter"): return "untyped value: a parameter"
    if L.startswith("untyped value: a local"): return "untyped value: a local"
    if L.startswith("untyped value: Type::method"): return "Rust Type::fn path not placed"
    if L.startswith("untyped value"): return "untyped value: an expression"
    M = {
        "callback parameter": "callback parameter",
        "local holding a function": "local holding a function",
        "loop over functions": "local holding a function",
        "closure-captured name": "closure-captured name",
        "obj[k]() — a function looked up by key": "obj[k]() lookup",
        "a call's result called: f(x)(y)": "a call's result called",
        "a function stored in a field: (self.f)(x)": "function stored in a field",
        "getattr / setattr": "getattr / setattr",
        "eval / exec / import by name": "eval / exec",
        ".call / .apply on a function value": ".call / .apply on a function value",
        "a trait method named call (Service::call)": "a method named call read as dynamic",
        "a repo method named call read as dynamic": "a method named call read as dynamic",
        "a Rust macro it doesn't follow": "a Rust macro it doesn't follow",
        "TS generic call after await read as an expression": "call shape misread",
        "dynamic import()": "dynamic import()",
        "a method named call/apply (Python)": "untyped value: an expression",
        "module-level value called": "a function value made outside the routine",
        "imported value called": "a function value made outside the routine",
        "interface call": "interface / trait / Protocol call",
        "trait call": "interface / trait / Protocol call",
        "Protocol/ABC call": "interface / trait / Protocol call",
        "a method subclasses override": "overridden method",
        "a method on self the class doesn't declare": "inherited method on self",
        "built-in / prelude name misread": "built-in name misread",
        "host global (setTimeout, fetch) misread": "built-in name misread",
        "a library import it doesn't place": "library import not placed",
        "imported name not resolved": "library import not placed",
        "a name from a wildcard import": "wildcard import",
        "a name declared nowhere visible": "a name declared nowhere visible",
        "a re-export it doesn't follow": "re-export not followed",
        "a name declared twice in the file": "name declared twice",
        "inside a Rust macro": "inside a Rust macro",
        "a Rust enum variant or pattern name": "built-in name misread",
        "a function defined inside the routine": "nested function not read",
        "a class defined inside the routine": "nested function not read",
        "super(...) constructor call": "call shape misread",
        "fn!() — a TS non-null call": "call shape misread",
        "new on an expression": "new on an expression",
        "a function written and called on the spot": "call shape misread",
        "an expression called": "an expression called",
    }
    return M.get(L, L)

def generic(why, lang):
    return {"abstract-receiver": "interface / trait / Protocol call", "overridden": "overridden method",
            "receiver": "untyped value: an expression", "unbound": "a name declared nowhere visible",
            "local-callee": "local holding a function", "computed": "an expression called",
            "unplaced": "library import not placed", "macro": "inside a Rust macro", "elsewhere": "re-export not followed",
            "ambiguous": "name declared twice", "dynamic": "getattr / setattr"}.get(why, why)

PYB = set("abs all any bool bytes callable chr dict dir enumerate filter float format frozenset getattr hasattr hash id int isinstance issubclass iter len list map max min next object open ord print range repr reversed round set setattr sorted str sum super tuple type vars zip".split())
RSB = set("Ok Err Some None Box String Vec Default".split())
RSM = set("println print eprintln vec assert assert_eq assert_ne debug_assert panic unreachable unimplemented todo matches cfg format write writeln dbg".split())
TSB = set("Error Array Object Promise Map Set Number String Boolean Symbol JSON Math Date RegExp setTimeout clearTimeout Response Request Headers URL fetch".split())
def fallback(w, lang):
    n, why, t = w["callee"], w["why"], w["text"]
    if why == "dynamic" and n in ("call", "apply"): return "a method named call read as dynamic"
    if why in ("unbound", "local-callee"):
        if t.startswith(n + "!"): return "built-in hidden by a wildcard import" if n in RSM else "a Rust macro it doesn't follow"
        if (lang == "python" and (n in PYB or n.endswith("Error") or n.endswith("Exception"))) or (lang == "rust" and n in RSB) or (lang == "ts" and n in TSB):
            return "built-in read as a local" if why == "local-callee" else "built-in hidden by a wildcard import"
    if why == "computed":
        if t.startswith("super("): return "call shape misread"
        if re.match(r"^\(\s*self\.\w+\s*\)|^\(\s*this\.\w+\s*\)", t): return "function stored in a field"
    return generic(why, lang)

def arrow_level(r, tk):
    rs, out = r["reason"], []
    if r["outcome"] == "green": out.append("confirmed though wrong")
    if "endpoint-not-found" in rs and "$" in r["from"] + r["to"]: out.append("a name with $ in it")
    elif "endpoint-not-found" in rs: out.append("an end not found")
    if "incomplete" in rs: out.append("TS grammar can't parse the file")
    if "one-level-up" in rs: out.append("reaches it in steps (route note)")
    if "endpoint-external" in rs: out.append("an end marked external")
    if tk.get("from") == "type": out.append("drawn from a class or struct")
    elif "not-declared" in rs or "routine-not-found" in rs: out.append("TS #private name written without #")
    if "inherits" in rs: out.append("class inherits code it can't read")
    if "may-create" in rs: out.append("head is a type the tail may create")
    if "reaches-the-file" in rs: out.append("reaches the head's file")
    if re.search(r"not-closed named$", rs): out.append("hands the head on as a value")
    if rs == "declined: macro": out.append("the head's name inside a Rust macro")
    elif "no-body" in rs and tk.get("from") != "type": out.append("starting function is a value, not a definition")
    if "type-alias" in rs: out.append("head is a type alias")
    if "set-at-run-time" in rs: out.append("a name set again at run time")
    if "handed-to-a-runner" in rs: out.append("a function handed to a runner")
    if "not-closed named" in rs and "hands the head on as a value" not in out: out.append("hands the head on as a value")
    if "compiler-says-it-does" in rs: out.append("compiler says it calls it")
    if "compiler-could-not-say" in rs: out.append("compiler could not say")
    return out

DESIGN = {"reaches it in steps (route note)"}

def load_set(s):
    rows = [r for r in json.load(open(f"{O}/rows-{s}.json")) if r["word"] == "calls"]
    dump = [json.loads(l) for l in open(f"{SC}/{s}.jsonl")]
    spans = {int(k): v for k, v in json.load(open(f"{O}/spans-{s}.json")).items()}
    T = collections.defaultdict(list)
    for l in open(f"{O}/sites-{s}.jsonl"):
        x = json.loads(l); T[x["id"]].append(x)
    reach, maxpass, bodies = {}, collections.defaultdict(int), collections.defaultdict(list)
    calls = collections.defaultdict(list)
    for l in open(f"{O}/walls-{s}.jsonl"):
        w = json.loads(l); aid = int(str(w["arrow"]).split("|")[0])
        st = w.get("stage")
        if st == "reach": reach[aid] = w
        elif st == "tail-body": bodies[aid].append(w)
        elif st is None:
            maxpass[aid] = max(maxpass[aid], w.get("pass") or 0); calls[aid].append(w)
    out = []
    for row in rows:
        aid = row["id"]; r = dump[aid]
        assert r["from"] == row["frm"] and r["to"] == row["to"], (s, aid)
        tk = TK.get(f"{s}:{aid}", {})
        tfile, _, tail = row["frm"].partition("#")
        tname = re.split(r"\.|::", tail)[-1] if tail else ""
        al = arrow_level(r, tk)
        if "TS #private name written without #" in al:
            root = {"main": "/Users/noelmatero/board-ai/.corpus", "holdout": "/Users/noelmatero/.board-ai-holdout/corpus", "holdout-b": "/Users/noelmatero/.board-ai-holdout-b/corpus"}[s]
            src = open(os.path.join(root, r["project"], tfile)).read()
            if "#" + tname not in src:
                al = [x if x != "TS #private name written without #" else "a plain function reported not declared" for x in al]
        cls = "drawn from a class or struct" in al
        if cls:
            sp = spans.get(aid, [])
            R = {b["routine"] for b in bodies[aid] if b["file"] == tfile and any(a <= b["line"] <= e for a, e in sp)}
        else:
            R = {tname}
        text = T[aid]
        mp = maxpass[aid]
        post = [w for w in calls[aid] if mp >= 2 and w["pass"] == mp and w["file"] == tfile and w["routine"] in R]
        # dedupe a pass's repeated readings of one body
        seen, P = set(), []
        for w in post:
            k = (w["routine"], w["callee"], w["why"], w["text"])
            if k not in seen: seen.add(k); P.append(w)
        lang = r["language"].replace("tsx", "ts")
        pats = collections.Counter(); ex = {}
        if P:
            asked = True
            for w in P:
                if w["why"] in ("abstract-receiver", "overridden"):
                    p = generic(w["why"], lang); lab = w["why"]
                else:
                    norm = lambda t: re.sub(r"\s+", " ", t)[:40]
                    m = [x for x in text if x["routine"] == w["routine"] and norm(x["detail"].split(" | ")[-1].split(": ", 1)[-1]) == norm(w["text"])] \
                        or [x for x in text if x["routine"] == w["routine"] and x["name"] == w["callee"] and x["why"] == w["why"]] \
                        or [x for x in text if x["routine"] == w["routine"] and x["name"] == w["callee"] and w["callee"]]
                    lab = m[0]["label"] if m else None
                    p = pattern_of(lab, lang, True, w["why"]) if lab else fallback(w, lang)
                pats[p] += 1; ex.setdefault(p, f'{w["file"]} {w["routine"]}: {w["text"][:90]}')
        elif mp >= 2 and r["reason"].startswith("declined: not-closed"):
            asked = True  # the body closed after the compiler; what is left is arrow-level
        else:
            asked = mp >= 2
            for x in text:
                p = pattern_of(x["label"], lang, asked, x["why"])
                pats[p] += 1; ex.setdefault(p, f'{x["file"]}:{x["line"]} {x["detail"][:90]}')
        if asked and lang == "rust" and any(x["why"] == "macro" for x in text) and "inside a Rust macro" not in pats:
            pats["inside a Rust macro"] += 1; ex["inside a Rust macro"] = next(f'{x["file"]}:{x["line"]} macro arguments' for x in text if x["why"] == "macro")
        if asked and r["reason"] == "declined: not-closed macro" and not pats:
            pats["inside a Rust macro"] += 1; ex["inside a Rust macro"] = "macro arguments in the tail (rustc list incomplete)"
        rv = reach.get(aid, {})
        if rv.get("verdict") == "reached" and "reaches it in steps (route note)" not in al:
            al = al + ["reaches it in steps (route note)"]; ex["reaches it in steps (route note)"] = " -> ".join(rv.get("via") or [])
        out.append({
            "set": s, "id": aid, "project": r["project"], "board": r["topic"], "lang": lang,
            "from": row["frm"], "to": row["to"], "source": r["source"], "reason": r["reason"], "outcome": r["outcome"],
            "arrowLevel": al, "sites": dict(pats), "patterns": sorted(set(al) | set(pats)), "asked": asked,
            "reached": rv.get("verdict") == "reached", "via": rv.get("via"), "examples": ex,
        })
    return out

allrec = []
for s in SETS: allrec += load_set(s)
json.dump(allrec, open(f"{O}/arrows.json", "w"), indent=0)
c = collections.Counter(p for a in allrec for p in a["patterns"])
alone = collections.Counter(a["patterns"][0] for a in allrec if len(a["patterns"]) == 1)
print(len(allrec), "arrows;", sum(1 for a in allrec if not a["patterns"]), "with no pattern")
for p, n in c.most_common(): print(f"{n:4} any  {alone[p]:3} alone  {p}")
