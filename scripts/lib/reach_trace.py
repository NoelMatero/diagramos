"""pytest plugin: which repository functions actually call which, as they run (#58).

Every Python-level call into a function under REACH_ROOT is recorded as an edge
from the nearest enclosing repository function on the stack. Frames in between --
the standard library, a dependency, a test, a lambda -- are passed through and the
edge is marked "through", which is how a callback a library invokes still counts
as being reached from the function that handed it over.

Tests, conftest, docs and examples are not repository functions here: a test is
not something anybody draws an arrow from.
"""
import json
import os
import sys
import threading

ROOT = os.path.realpath(os.environ["REACH_ROOT"])
OUT = os.environ["REACH_OUT"]
NOT_SOURCE_DIRS = {"tests", "test", "testing", "docs", "examples"}
TRANSPARENT = {"<lambda>", "<listcomp>", "<genexpr>", "<dictcomp>", "<setcomp>"}

_relative = {}


def relative_of(code):
    filename = code.co_filename
    hit = _relative.get(filename)
    if hit is None:
        hit = ""
        # `<frozen posixpath>`, `<string>`, `<template>`: code with no file. realpath
        # resolves such a name against the working directory, which put every
        # standard-library frame inside the repository and broke real call chains
        # into pieces nothing could match -- 587 of 1,097 edges on flask's first run.
        if filename.startswith("<") or not os.path.isabs(filename):
            _relative[filename] = hit
            return hit
        real = os.path.realpath(filename)
        if real.startswith(ROOT + os.sep):
            rel = real[len(ROOT) + 1:]
            parts = rel.split(os.sep)
            base = parts[-1]
            if not (NOT_SOURCE_DIRS & set(parts[:-1]) or base.startswith("test_") or base == "conftest.py"):
                hit = rel
        _relative[filename] = hit
    return hit


def is_routine(code):
    return bool(relative_of(code)) and code.co_name not in TRANSPARENT and code.co_name != "<module>"


edges = {}


def profile(frame, event, arg):
    if event != "call":
        return
    code = frame.f_code
    if not is_routine(code):
        return
    through = False
    parent = frame.f_back
    while parent is not None:
        parent_code = parent.f_code
        if is_routine(parent_code):
            break
        if relative_of(parent_code) and parent_code.co_name == "<module>":
            parent = None  # import-time code in a module body: no routine called this
            break
        through = True
        parent = parent.f_back
    if parent is None:
        return
    p = parent.f_code
    key = (relative_of(p), p.co_name, p.co_firstlineno, relative_of(code), code.co_name, code.co_firstlineno, through)
    edges[key] = edges.get(key, 0) + 1


def pytest_configure(config):
    sys.setprofile(profile)
    threading.setprofile(profile)


def pytest_sessionfinish(session, exitstatus):
    sys.setprofile(None)
    threading.setprofile(None)
    with open(OUT, "w") as handle:
        json.dump({
            "root": ROOT,
            "testsCollected": session.testscollected,
            "testsFailed": session.testsfailed,
            "edges": [list(key) + [count] for key, count in edges.items()],
        }, handle)
