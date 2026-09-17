"""The wiring. SKILL.md: the wiring usually lives in a third file the board
often does not draw at all -- this file, not `stages.py`."""

from .stages import collect, format_, parse, render


def run(text: str) -> str:
    """PLAINLY TRUE: parse's result is bound and passed straight into render."""
    value = parse(text)
    return render(value)


def unrelated() -> int:
    """FALSE AND UNPROVABLE: nothing here connects the two."""
    return 0


class Held:
    """TRUE BUT HIDDEN: collect's result really does reach format_, through a
    struct field -- SKILL.md's own example of a place "no reader follows".
    `collect`/`format_` have no other wiring routine, so this is the only
    evidence there is to find, and the checker still cannot find it."""

    def __init__(self, value: int) -> None:
        self.value = value


def run_via_field(text: str) -> str:
    held = Held(collect(text))
    return format_(held.value)
