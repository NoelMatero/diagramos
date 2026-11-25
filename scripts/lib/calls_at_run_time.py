"""calls_at_run_time.py <src-root> <out.json> <pytest args...>

Run a project's tests and record every call the interpreter really makes between two functions of the
project: which function called, on which line, and the function object that was called. `sys.monitoring`'s
CALL event (Python 3.12+) hands over the callable itself, so a callback, a stored function and a method found
by dispatch are all seen as what they are. The referee for "does T directly call H" that shares nothing with
the checker; `scripts/measure-calls-at-run-time.mts` runs it and checks what it recorded.

how = function | method | class (a class called: its __init__ runs) | partial (functools.partial of a project function)

Written for the calls research of 2026-11 (side finding 1: `with console:` called wrong on main).
"""
import functools
import json
import os
import sys
import types

SRC = os.path.realpath(sys.argv[1]) + os.sep
OUT = sys.argv[2]
ARGS = sys.argv[3:]

mon = sys.monitoring
TOOL = mon.PROFILER_ID
seen = set()
inside = {}


def is_inside(filename):
    hit = inside.get(filename)
    if hit is None:
        hit = inside[filename] = os.path.realpath(filename).startswith(SRC) if filename and not filename.startswith("<") else False
    return hit


def on_call(code, offset, callee, arg0):
    if not is_inside(code.co_filename):
        return mon.DISABLE
    how = "function"
    func = callee
    if isinstance(func, types.MethodType):
        how = "method"
        func = func.__func__
    elif isinstance(func, functools.partial):
        how = "partial"
        func = func.func
        if isinstance(func, types.MethodType):
            func = func.__func__
    elif isinstance(func, type):
        init = func.__dict__.get("__init__")
        if isinstance(init, types.FunctionType) and is_inside(init.__code__.co_filename):
            seen.add((code, offset, init.__code__, "class"))
        return None
    if not isinstance(func, types.FunctionType):
        return None
    target = func.__code__
    if not is_inside(target.co_filename):
        return None
    seen.add((code, offset, target, how))
    return None


mon.use_tool_id(TOOL, "rt_trace")
mon.register_callback(TOOL, mon.events.CALL, on_call)
mon.set_events(TOOL, mon.events.CALL)

status = None
try:
    import pytest
    status = pytest.main(ARGS)
except SystemExit as stop:
    status = stop.code
finally:
    mon.set_events(TOOL, 0)
    lines = {}

    def line_of(code, offset):
        table = lines.get(code)
        if table is None:
            table = lines[code] = [(start, end, line) for start, end, line in code.co_lines()]
        for start, end, line in table:
            if start <= offset < end:
                return line
        return None

    out = {}
    for code, offset, target, how in seen:
        key = (os.path.relpath(os.path.realpath(code.co_filename), SRC), code.co_qualname, code.co_firstlineno, line_of(code, offset),
               os.path.relpath(os.path.realpath(target.co_filename), SRC), target.co_qualname, target.co_firstlineno, how)
        out[key] = out.get(key, 0) + 1
    rows = [dict(zip(("file", "caller", "callerLine", "line", "calleeFile", "callee", "calleeLine", "how"), key)) for key in sorted(out, key=str)]
    with open(OUT, "w") as handle:
        json.dump({"src": SRC, "status": str(status), "edges": rows}, handle)
    print(f"rt_trace: {len(rows)} edges, pytest status {status}", file=sys.stderr)
