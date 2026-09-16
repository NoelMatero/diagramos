"""TRUE BUT HIDDEN: the base is imported under an alias, so `class Aliased(B):`
does not spell the name the diagram uses.

SKILL.md's own example is `import { Base as B }`; the Python spelling of the
same thing is `from .model import Base as B`.
"""

from .model import Base as B


class Aliased(B):
    pass
