"""Drop-in for `e2b_code_interpreter.Sandbox`.

Usage:

    from arker.e2b.code_interpreter import Sandbox

    sbx = Sandbox()
    ex = sbx.run_code("print(2+2)")
    print(ex.text)       # -> "4\n"

Backed by `arker.e2b.Sandbox` — same VM lifecycle, plus a `.run_code(code,
language="python", ...)` method. Charts/results (`ex.results`) are not
populated in Phase 1; `ex.text`, `ex.logs`, and `ex.error` are.
"""

from ._sandbox import Sandbox
from ._types import Execution, ExecutionError, Logs, Result

__all__ = ["Execution", "ExecutionError", "Logs", "Result", "Sandbox"]
