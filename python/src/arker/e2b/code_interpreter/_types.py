"""e2b_code_interpreter return types."""

from __future__ import annotations

import dataclasses


@dataclasses.dataclass(frozen=True)
class Logs:
    stdout: list[str] = dataclasses.field(default_factory=list)
    stderr: list[str] = dataclasses.field(default_factory=list)


@dataclasses.dataclass(frozen=True)
class ExecutionError:
    name: str
    value: str
    traceback: str


@dataclasses.dataclass(frozen=True)
class Result:
    """Chart/figure/HTML output. Not populated in Phase 1 — placeholder so
    user code that destructures `ex.results` doesn't AttributeError."""
    text: str | None = None
    html: str | None = None
    markdown: str | None = None
    png: str | None = None
    jpeg: str | None = None
    svg: str | None = None
    json_: dict | None = None
    is_main_result: bool = False


@dataclasses.dataclass(frozen=True)
class Execution:
    """e2b-shaped execution result.

    `text` mirrors e2b's semantics: it is the textual representation of the
    last-expression value (the `is_main_result` Result), NOT stdout. Stdout
    lives in `logs.stdout`. Until we wire up a Jupyter kernel that emits
    `results[]`, `text` is always `None` here — matching e2b's behavior when
    the snippet has no expression value.
    """
    logs: Logs = dataclasses.field(default_factory=Logs)
    error: ExecutionError | None = None
    results: list[Result] = dataclasses.field(default_factory=list)

    @property
    def text(self) -> str | None:
        for r in self.results:
            if r.is_main_result and r.text is not None:
                return r.text
        return None

    @property
    def exit_code(self) -> int:
        return 0 if self.error is None else 1
