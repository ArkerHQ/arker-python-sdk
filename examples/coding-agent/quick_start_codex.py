#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["arker>=1.2"]
# ///
"""Background coding agent — quick start (Codex).

Forks a source VM that already contains the OpenAI Codex CLI and runs it inside.

Self-contained: uv reads the inline dependency block above and runs it in a
temporary environment, so there is nothing to install first.

    ARKER_API_KEY=... OPENAI_API_KEY=... uv run quick_start_codex.py
"""
import os
import sys

from arker import Arker

# Placement of the compute host, and a public source image that already ships
# Codex. Override any of these through the environment.
PROVIDER = os.environ.get("ARKER_PROVIDER", "aws")
REGION = os.environ.get("ARKER_REGION", "us-west-2")
SOURCE_VM = os.environ.get("ARKER_SOURCE_VM", "ubuntu-coding")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.6-sol")
PROMPT = "create hello.py that prints hello world, then run it"


def required(var: str) -> str:
    value = os.environ.get(var)
    if not value:
        sys.exit(f"{var} is required")
    return value


def main() -> int:
    openai_key = required("OPENAI_API_KEY")
    client = Arker(api_key=required("ARKER_API_KEY"), provider=PROVIDER, region=REGION)

    vm = client.fork(SOURCE_VM)
    print(f"forked {vm.vm_id}", flush=True)
    try:
        # The source already contains Codex, so no install is necessary. Codex
        # reads credentials from its own config rather than the environment, so
        # authenticate once before running anything.
        login = vm.run(f"printf '%s' {openai_key!r} | codex login --with-api-key")
        if login.exit_code != 0:
            print(login.stderr or login.stdout, end="", file=sys.stderr)
            return login.exit_code

        # --dangerously-bypass-approvals-and-sandbox skips approvals and Codex's
        # own sandbox, which a non-interactive run needs since nothing can answer
        # a prompt (safe: the VM is an isolated throwaway). The agent runs for
        # minutes; run() backgrounds past the sync window and polls to completion.
        result = vm.run(
            f"codex exec --model {MODEL} "
            f"--dangerously-bypass-approvals-and-sandbox {PROMPT!r}"
        )
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        return result.exit_code
    finally:
        vm.delete()


if __name__ == "__main__":
    sys.exit(main())
