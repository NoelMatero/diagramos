"""TRUE BUT HIDDEN: the dependency is resolved at runtime by name, so the
specifier is a string and the reader has no import statement to place.

Shape from .corpus/django-django/django/utils/module_loading.py:15 —
`module = import_module(module_path)`.
"""

from importlib import import_module


def handle(path: str) -> int:
    module = import_module("bench.fixtures.needs.python.model")
    return len(module.Request(path).path)
