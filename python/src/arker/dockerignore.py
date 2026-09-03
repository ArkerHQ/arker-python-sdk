"""`.dockerignore` matching for the build context.

`COPY . /app` without this ships `.git` and `.env` into the VM. That is not
only wasteful — a repo's `.git/config` carries push credentials and a `.env`
carries whatever the project keeps there — so the file is a correctness AND a
disclosure concern, not a performance tweak.

## Semantics

Docker's, with the parts real files actually use:

* One pattern per line; blank lines and `#` comments ignored.
* Paths are matched relative to the context root, with `/` separators.
* `*` and `?` match within one path segment; `**` matches across segments.
* A leading `/` is stripped — every pattern is already context-relative.
* A pattern that matches a DIRECTORY excludes everything under it, which is
  what makes a bare `node_modules` do what everyone expects.
* `!` negates, and the LAST matching pattern wins. That ordering is the whole
  reason `*` followed by `!keep.txt` works.

Deliberately not implemented: `\\` escaping of a leading `!` or `#`. Nothing
writes those, and guessing at them silently would be worse than leaving them
as literal characters.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

__all__ = ["DockerIgnore", "load_dockerignore"]


def _pattern_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate one `.dockerignore` pattern into a full-match regex.

    Hand-rolled rather than `fnmatch`, which cannot express `**`: it maps `*`
    to `.*`, so `a*b` would wrongly match across separators and a bare
    `node_modules` would behave differently from `node_modules/**`.
    """
    out = ["^"]
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern[i : i + 2] == "**":
                out.append(".*")
                i += 2
                # `**/` should also match zero directories, so `**/x` matches `x`.
                if pattern[i : i + 1] == "/":
                    out[-1] = "(?:.*/)?"
                    i += 1
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(char))
        i += 1
    out.append("$")
    return re.compile("".join(out))


@dataclass
class DockerIgnore:
    """Compiled patterns, in file order. Last match wins."""

    rules: list[tuple[re.Pattern[str], bool]]

    def ignores(self, rel_path: str) -> bool:
        """Is `rel_path` (context-relative, `/`-separated) excluded?

        Every ancestor is tested too, so a rule naming a directory excludes the
        files under it without needing a `/**` suffix.
        """
        if not self.rules:
            return False

        candidates = [rel_path]
        parent = os.path.dirname(rel_path)
        while parent:
            candidates.append(parent)
            parent = os.path.dirname(parent)

        ignored = False
        matched = False
        for regex, negated in self.rules:
            if any(regex.match(candidate) for candidate in candidates):
                ignored = not negated
                matched = True
        return ignored if matched else False


def load_dockerignore(context_root: str) -> DockerIgnore:
    """Read `<context_root>/.dockerignore`. Absent means nothing is excluded."""
    path = os.path.join(context_root, ".dockerignore")
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
        return DockerIgnore(rules=[])

    rules: list[tuple[re.Pattern[str], bool]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        if negated:
            line = line[1:].strip()
        line = line.lstrip("/").rstrip("/")
        if not line:
            continue
        rules.append((_pattern_to_regex(line), negated))
    return DockerIgnore(rules=rules)
