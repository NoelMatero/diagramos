"""The Python referee for `measure:compiler-true` (#393, part 3).

jedi -- parso and jedi's own inference, nothing shared with the pyright the
product asks or the tree-sitter it reads -- lists every pair it says is true:

  holds     a class's field (class level, or `self.x =` in any method) has a
            value of the head's class, by annotation or by inference
  takes     a parameter does: annotated, or inferred from the defaults and the
            call sites jedi finds
  returns   calling the routine gives one
  conforms  the head is a base of the class, at any depth
  calls     a call in the routine lands on the head routine
  accesses  a `.name` read in the routine lands on a member the head class declares

    $JEDI_PYTHON scripts/lib/compiler_true_jedi.py <repo root> <subdir>... > pairs.json

What it cannot see: a Protocol the class fits without naming it, a type
written only as a string or behind `TYPE_CHECKING` jedi does not follow, a
generic's argument it drops (`list[Request]` is a `list`), and a call
through a value it cannot infer.
"""
import json, os, re, sys, collections
import jedi, parso

root, subdirs = sys.argv[1], sys.argv[2:]
project = jedi.Project(root, added_sys_path=[root + "/src"] if os.path.isdir(root + "/src") else [])
files = []
for sub in subdirs:
    for d, dirs, fs in os.walk(f"{root}/{sub}"):
        dirs[:] = sorted(x for x in dirs if x not in ("tests", "test", "__pycache__"))
        files += [f"{d}/{f}" for f in sorted(fs) if f.endswith(".py")]


def walk(n):
    yield n
    for c in getattr(n, "children", []):
        yield from walk(c)


modules, classes = {}, collections.defaultdict(list)
for path in files:
    code = open(path, encoding="utf8").read()
    m = parso.parse(code)
    modules[path] = (code, m)
    for n in m.children:
        n = unwrap(n)
        if n.type == "classdef":
            classes[n.name.value].append(os.path.relpath(path, root))
unique = {k: v[0] for k, v in classes.items() if len(v) == 1}


def unwrap(n):
    """A definition, with decorators and `async` looked through."""
    while n.type in ("decorated", "async_funcdef", "async_stmt"):
        n = n.children[-1]
    return n


def top(module):
    """Top-level classdefs and funcdefs."""
    for n in module.children:
        n = unwrap(n)
        if n.type in ("classdef", "funcdef"):
            yield n


def methods(klass):
    for n in klass.children[-1].children if klass.children[-1].type == "suite" else []:
        n = unwrap(n)
        if n.type == "funcdef":
            yield n


def project_class(name):
    """A jedi Name for a class in this project declared once, or None."""
    if name.type not in ("class", "instance") or name.name not in unique:
        return None
    if not name.module_path or not str(name.module_path).startswith(root):
        return None
    if unique[name.name] != os.path.relpath(str(name.module_path), root):
        return None
    return name.name


def safe(f, *a, **k):
    try:
        return f(*a, **k)
    except Exception:
        return []


pairs, seen = [], set()


def add(word, frm, to, how, label=None):
    key = (word, frm, to, label)
    if key in seen:
        return
    seen.add(key)
    pair = {"word": word, "from": frm, "to": to, "how": how}
    if label:
        pair["label"] = label
    pairs.append(pair)


def names_in(node):
    return [n for n in walk(node) if n.type == "name"]


def annotation_classes(script, node):
    """Project classes an annotation names, each name followed by jedi."""
    out = set()
    if node is None:
        return out
    for leaf in names_in(node):
        for d in safe(script.infer, *leaf.start_pos):
            c = project_class(d)
            if c:
                out.add(c)
    return out


def value_classes(found):
    return {c for c in (project_class(d) for d in found) if c}


# Every routine a board can point at, by ref, and its parso node.
routine_ref = {}  # (path, line of def name) -> ref
routines = []
for path, (code, m) in modules.items():
    rel = os.path.relpath(path, root)
    found = []
    for n in top(m):
        if n.type == "funcdef":
            found.append((f"{rel}#{n.name.value}", n, None))
        elif n.type == "classdef":
            for f in methods(n):
                found.append((f"{rel}#{n.name.value}.{f.name.value}", f, n))
    counts = collections.Counter(ref for ref, _, _ in found)
    for ref, f, klass in found:
        if counts[ref] != 1:
            continue
        routines.append((path, ref, f, klass))
        routine_ref[(path, f.name.start_pos[0])] = ref


def owner_of(name):
    """The (path, top-level classdef) a jedi definition sits in, at class level or as `self.x`."""
    if not name.module_path:
        return None
    path = str(name.module_path)
    if path not in modules or name.line is None:
        return None
    leaf = modules[path][1].get_leaf_for_position((name.line, name.column))
    node = leaf
    while node is not None and node.type != "classdef":
        node = node.parent
    if node is None or node.parent is None:
        return None
    parent = node.parent if node.parent.type != "decorated" else node.parent.parent
    if parent.type != "file_input":
        return None
    return path, node


for path, (code, m) in modules.items():
    rel = os.path.relpath(path, root)
    script = jedi.Script(code=code, path=path, project=project)

    for klass in (n for n in top(m) if n.type == "classdef"):
        holder = klass.name.value
        if unique.get(holder) != rel:
            continue
        # conforms: every base, at any depth.
        frontier, depth, done = [(path, klass)], 0, set()
        while frontier and depth < 12:
            nxt = []
            for kpath, k in frontier:
                ch = k.children
                if len(ch) < 4 or getattr(ch[2], "value", None) != "(":
                    continue
                kscript = script if k is klass else jedi.Script(code=modules[kpath][0], path=kpath, project=project)
                for leaf in names_in(ch[3]):
                    # A keyword argument -- `metaclass=Meta` -- is not a base, name or value.
                    if any(p.type == "argument" for p in (leaf.parent, leaf.parent.parent if leaf.parent else None) if p is not None):
                        continue
                    for b in safe(kscript.infer, *leaf.start_pos):
                        c = project_class(b)
                        if not c or c in done or c == holder:
                            continue
                        done.add(c)
                        add("conforms", f"{rel}#{holder}", f"{unique[c]}#{c}", "written" if depth == 0 else "ancestor")
                        o = owner_of(b)
                        if o:
                            nxt.append(o)
            frontier, depth = nxt, depth + 1

        # holds: class-level fields, and `self.x` assigned in any method.
        sites = []  # (name leaf, annotation node or None)
        for n in klass.children[-1].children if klass.children[-1].type == "suite" else []:
            stmt = n.children[0] if n.type == "simple_stmt" else None
            if stmt is None or stmt.type != "expr_stmt":
                continue
            target = stmt.children[0]
            if target.type != "name" or target.value.startswith("__"):
                continue
            annotation = stmt.children[1].children[1] if len(stmt.children) > 1 and stmt.children[1].type == "annassign" else None
            sites.append((target, annotation))
        for f in methods(klass):
            params = f.get_params()
            if not params or params[0].name.value != "self":
                continue
            for n in walk(f):
                if n.type != "expr_stmt":
                    continue
                target = n.children[0]
                if target.type not in ("power", "atom_expr") or len(target.children) != 2:
                    continue
                head, trailer = target.children
                if head.type != "name" or head.value != "self" or trailer.children[0].value != ".":
                    continue
                name = trailer.children[1]
                if name.value.startswith("__"):
                    continue
                annotation = n.children[1].children[1] if len(n.children) > 1 and n.children[1].type == "annassign" else None
                sites.append((name, annotation))
        for leaf, annotation in sites:
            written = annotation_classes(script, annotation)
            for c in written:
                if c != holder:
                    add("holds", f"{rel}#{holder}", f"{unique[c]}#{c}", "written")
            for c in value_classes(safe(script.infer, *leaf.start_pos)):
                if c != holder:
                    add("holds", f"{rel}#{holder}", f"{unique[c]}#{c}", "written" if c in written else "inferred")

for path, ref, f, klass in routines:
    code, m = modules[path]
    rel = os.path.relpath(path, root)
    script = jedi.Script(code=code, path=path, project=project)

    # takes: every parameter but the receiver.
    params = f.get_params()
    if klass is not None and params and params[0].name.value in ("self", "cls"):
        params = params[1:]
    body = f.children[-1]
    for p in params:
        written = annotation_classes(script, p.annotation)
        for c in written:
            add("takes", f"{unique[c]}#{c}", ref, "written")
        # Asked where the parameter is used, not where it is declared: only
        # there does jedi look at the calls that pass it (dynamic params).
        use = next((n for n in walk(body) if n.type == "name" and n.value == p.name.value), None)
        found = safe(script.infer, *p.name.start_pos) + (safe(script.infer, *use.start_pos) if use else [])
        for c in value_classes(found):
            add("takes", f"{unique[c]}#{c}", ref, "written" if c in written else "inferred")

    # returns: what calling it gives.
    written = annotation_classes(script, f.annotation)
    for c in written:
        add("returns", f"{unique[c]}#{c}", ref, "written")
    for d in safe(script.infer, *f.name.start_pos):
        if d.type != "function":
            continue
        for c in value_classes(safe(d.execute)):
            add("returns", f"{unique[c]}#{c}", ref, "written" if c in written else "inferred")

    # calls and accesses, off every name a trailer follows.
    for n in walk(f.children[-1]):
        if n.type not in ("power", "atom_expr"):
            continue
        ch = n.children
        for i, c in enumerate(ch):
            if i == 0 or c.type != "trailer":
                continue
            prev = ch[i - 1]
            called = c.children[0].value == "("
            if called:
                leaf = prev.children[-1] if prev.type == "trailer" and prev.children[0].value == "." else (prev if prev.type == "name" else None)
                if leaf is None or leaf.type != "name":
                    continue
                for d in safe(script.goto, *leaf.start_pos, follow_imports=True):
                    if d.type != "function" or not d.module_path:
                        continue
                    callee = routine_ref.get((str(d.module_path), d.line))
                    if callee and callee != ref:
                        add("calls", ref, callee, "written" if leaf.value == d.name else "other-name")
            elif c.children[0].value == ".":
                following = ch[i + 1] if i + 1 < len(ch) else None
                if following is not None and following.type == "trailer" and following.children[0].value == "(":
                    continue
                leaf = c.children[1]
                for d in safe(script.goto, *leaf.start_pos, follow_imports=True):
                    o = owner_of(d)
                    if not o:
                        continue
                    owner = o[1].name.value
                    if unique.get(owner) != os.path.relpath(o[0], root):
                        continue
                    add("accesses", ref, f"{unique[owner]}#{owner}", "written", label=leaf.value)

print(json.dumps(pairs))
print(f"{os.path.basename(root)}: {len(files)} files, {len(pairs)} pairs", file=sys.stderr)
