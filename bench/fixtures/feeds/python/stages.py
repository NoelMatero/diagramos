"""The pipeline stages, in two independent pairs so the plain and hidden flow
tests do not share a candidate pool."""


def parse(text: str) -> int:
    return len(text)


def render(n: int) -> str:
    return str(n)


def collect(text: str) -> int:
    return len(text)


def format_(n: int) -> str:
    return str(n)
