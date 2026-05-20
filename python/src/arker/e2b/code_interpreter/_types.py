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
    text: str = ""
    logs: Logs = dataclasses.field(default_factory=Logs)
    error: ExecutionError | None = None
    results: list[Result] = dataclasses.field(default_factory=list)

    @property
    def exit_code(self) -> int:
        return 0 if self.error is None else 1
