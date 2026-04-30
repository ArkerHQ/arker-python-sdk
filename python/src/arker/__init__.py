"""Arker — single-file Python client for the Arker virtual computer
platform. See README.md for the quickstart, `arker/computer.py` for
the implementation, and `docs/sync-api.md` for wire-level details."""
from .computer import Arker, Computer, Sync, RunResult, VmSummary, VmList, ArkerError

__all__ = ["Arker", "Computer", "Sync", "RunResult", "VmSummary", "VmList", "ArkerError"]
__version__ = "0.1.0"
