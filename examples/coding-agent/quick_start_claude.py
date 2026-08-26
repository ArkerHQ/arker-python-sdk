#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["arker>=1.2"]
# ///
"""Background coding agent — quick start (Claude Code).

Forks a source VM that already contains Claude Code and runs the CLI inside it.

Self-contained: uv reads the inline dependency block above and runs it in a
temporary environment, so there is nothing to install first.

    ARKER_API_KEY=... ANTHROPIC_API_KEY=... uv run quick_start_claude.py
"""
import os
import sys

from arker import Arker

# Placement of the compute host, and a public source image that already ships
# Claude Code. Override any of these through the environment.
PROVIDER = os.environ.get("ARKER_PROVIDER", "aws")
REGION = os.environ.get("ARKER_REGION", "us-west-2")
SOURCE_VM = os.environ.get("ARKER_SOURCE_VM", "ubuntu-coding")
# Full model id, or an alias for the latest of a family ("opus", "sonnet").
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5")
PROMPT = "create hello.py that prints hello world, then run it"


def required(var: str) -> str:
    value = os.environ.get(var)
    if not value:
        sys.exit(f"{var} is required")
    return value


def main() -> int:
    anthropic_key = required("ANTHROPIC_API_KEY")
    client = Arker(api_key=required("ARKER_API_KEY"), provider=PROVIDER, region=REGION)

    vm = client.fork(SOURCE_VM)
    print(f"forked {vm.vm_id}", flush=True)
    try:
        # The source already contains Claude Code, so no install is necessary.
        # --dangerously-skip-permissions auto-approves tool use, which a -p run
        # needs since nothing can answer a prompt. Claude Code refuses that flag
        # as root, and runs here are root, so IS_SANDBOX=1 waives the check —
        # safe because the VM is an isolated throwaway. The agent runs for
        # minutes; run() backgrounds past the sync window and polls to completion.
        result = vm.run(
            f"IS_SANDBOX=1 ANTHROPIC_API_KEY={anthropic_key} "
            f"claude -p {PROMPT!r} --model {MODEL} --dangerously-skip-permissions"
        )
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        return result.exit_code
    finally:
        vm.delete()


if __name__ == "__main__":
    sys.exit(main())
