"""Live end-to-end coverage for `fork(dockerfile=...)`.

The unit suite proves the driver writes the guest config; only a real VM
proves the agent honours it. Costs one VM.

    ARKER_API_KEY=ark_live_... \\
    ARKER_PROVIDER=aws \\
    ARKER_REGION=us-east-1 \\
    uv run pytest tests/e2e/test_dockerfile_e2e.py -q
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator

import pytest

from arker import VM, Arker

DOCKERFILE = """\
FROM ubuntu:24.04
RUN useradd -m -s /bin/bash appuser
ENV GREETING=hello
WORKDIR /app
USER appuser
"""


@pytest.fixture(scope="module")
def vm(tmp_path_factory) -> Iterator[VM]:
    context = tmp_path_factory.mktemp("context")
    (context / "Dockerfile").write_text(DOCKERFILE)
    client = Arker(
        api_key=os.environ.get("ARKER_API_KEY"),
        base_url=os.environ.get("ARKER_BASE_URL"),
        provider=os.environ.get("ARKER_PROVIDER"),
        region=os.environ.get("ARKER_REGION"),
    )
    built = client.fork(
        dockerfile=str(context / "Dockerfile"),
        context=str(context),
        name="python-sdk-dockerfile-e2e",
    )
    try:
        yield built
    finally:
        built.delete()


def test_the_final_user_applies_to_the_delivered_vm(vm: VM) -> None:
    """A Dockerfile ending in USER must not hand back a root shell."""
    assert vm.run("whoami").stdout.strip() == "appuser"


def test_the_final_workdir_applies_to_the_delivered_vm(vm: VM) -> None:
    assert vm.run("pwd").stdout.strip() == "/app"


def test_user_and_workdir_apply_in_a_session_the_build_never_used(vm: VM) -> None:
    """Shell state is per-session; the guest config is what makes it VM-wide."""
    out = vm.run("whoami; pwd", session_idx=9).stdout.split()
    assert out == ["appuser", "/app"]


def test_the_builds_env_survives_the_session_reset(vm: VM) -> None:
    """Persisting the config drops the build's session so it respawns.

    The agent recovers a respawned session's exported environment from disk,
    which is the only reason `ENV` still holds afterwards — a reset that lost
    it would be a silent regression for every Dockerfile that exports anything.
    """
    assert vm.run("echo $GREETING").stdout.strip() == "hello"


def test_user_and_workdir_survive_a_fork(vm: VM) -> None:
    child = vm.fork(name="python-sdk-dockerfile-e2e-child")
    try:
        assert child.run("whoami; pwd", session_idx=11).stdout.split() == ["appuser", "/app"]
    finally:
        child.delete()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
