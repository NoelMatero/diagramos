"""The Python referee for `measure:builds-absent` (#362, from #360's probe).

jedi -- parso and its own inference, nothing shared with pyright or tree-sitter --
says which project classes each routine calls. Calling a class is creating one.

    $JEDI_PYTHON scripts/lib/builds_jedi.py <corpus> <project> <subdir>... > pairs.json
"""
import json, os, sys, collections
import jedi, parso

CORPUS, project_name, subdirs = sys.argv[1], sys.argv[2], sys.argv[3:]
root = f"{CORPUS}/{project_name}"
project = jedi.Project(root, added_sys_path=[root + "/src"] if os.path.isdir(root + "/src") else [])
files = []
for sub in subdirs:
    for d, dirs, fs in os.walk(f"{root}/{sub}"):
        dirs[:] = [x for x in dirs if x not in ("tests", "test", "__pycache__")]
        files += [f"{d}/{f}" for f in fs if f.endswith(".py")]

def walk(n):
    yield n
    for c in getattr(n, "children", []):
        yield from walk(c)

classes = collections.defaultdict(list)
modules = {}
for path in files:
    code = open(path, encoding="utf8").read()
    m = parso.parse(code); modules[path] = (code, m)
    for n in walk(m):
        if n.type == "classdef":
            classes[n.name.value].append(os.path.relpath(path, root))
unique = {k: v[0] for k, v in classes.items() if len(v) == 1}

def class_at(path, line):
    """The parso classdef whose name is on this 1-based line of a project file."""
    if path not in modules: return None
    for n in walk(modules[path][1]):
        if n.type == "classdef" and n.name.start_pos[0] == line: return n
    return None

def ancestors(d, depth=0, seen=None):
    """Every project class a jedi class Name derives from, at any depth (#362's review)."""
    seen = set() if seen is None else seen
    if depth > 12 or not d.module_path: return []
    path = str(d.module_path)
    klass = class_at(path, d.line)
    if klass is None: return []
    found = []
    script = jedi.Script(code=modules[path][0], path=path, project=project)
    ch = klass.children
    if len(ch) < 4 or getattr(ch[2], "value", None) != "(": return []
    for leaf in (n for n in walk(ch[3]) if n.type == "name"):
        # A keyword argument's name (`metaclass=`) is not a base.
        nxt = leaf.get_next_leaf()
        if nxt is not None and nxt.value == "=": continue
        try:
            inferred = script.infer(*leaf.start_pos)
        except Exception:
            continue
        for b in inferred:
            if b.type != "class" or b.name not in unique: continue
            if not b.module_path or not str(b.module_path).startswith(root): continue
            key = (str(b.module_path), b.line)
            if key in seen: continue
            seen.add(key)
            found.append(b)
            found += ancestors(b, depth + 1, seen)
    return found

pairs, seen = [], set()
for path, (code, m) in modules.items():
    rel = os.path.relpath(path, root)
    script = jedi.Script(code=code, path=path, project=project)
    for fn in (n for n in walk(m) if n.type == "funcdef"):
        routine = fn.name.value
        for n in walk(fn):
            if n.type not in ("power", "atom_expr"): continue
            ch = n.children
            for i, c in enumerate(ch):
                if not (c.type == "trailer" and c.children[0].value == "("): continue
                prev = ch[i - 1]
                if prev.type == "trailer":
                    leaf = prev.children[-1] if prev.children[0].value == "." else None
                    spelled = "attribute"
                else:
                    leaf = prev if prev.type == "name" else None
                    spelled = "name"
                if leaf is None or leaf.type != "name": continue
                try:
                    found = script.infer(*leaf.start_pos)
                except Exception:
                    continue
                for d in found:
                    if d.type != "class" or d.name not in unique: continue
                    if not d.module_path or not str(d.module_path).startswith(root): continue
                    how = "direct" if leaf.value == d.name else f"other-{spelled}"
                    key = (rel, routine, d.name)
                    if key in seen: continue
                    seen.add(key)
                    pairs.append({"from": f"{rel}#{routine}", "to": f"{unique[d.name]}#{d.name}", "kind": how, "target": "class", "wrote": leaf.value})
                for d in found:
                    if d.type != "class" or d.name not in unique: continue
                    if not d.module_path or not str(d.module_path).startswith(root): continue
                    for b in ancestors(d):
                        key = (rel, routine, b.name)
                        if key in seen: continue
                        seen.add(key)
                        pairs.append({"from": f"{rel}#{routine}", "to": f"{unique[b.name]}#{b.name}", "kind": "ancestor", "target": "class", "wrote": leaf.value})
print(json.dumps(pairs))
print(f"{project_name}: {len(files)} files, {len(pairs)} pairs", file=sys.stderr)
