"""The types the signatures name, and the alias that hides one.

Class shape from .corpus/encode-httpx/httpx/_models.py:382 (`class Request`).
Alias shape from .corpus/vuejs-core is TypeScript; the Python equivalent here is
an ordinary module-level assignment, which is how an alias is spelled.
"""


class Request:
    def __init__(self, path: str) -> None:
        self.path = path


class Response:
    def __init__(self, code: int) -> None:
        self.code = code


class Thing:
    def __init__(self, tag: int) -> None:
        self.tag = tag


# The alias. An annotation naming `Req` names `Request` and does not say so.
Req = Request
