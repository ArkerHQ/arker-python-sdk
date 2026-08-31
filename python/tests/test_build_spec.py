"""Dockerfile parsing for the SDK-driven build.

The SDK builds a Dockerfile by forking from `FROM` and then driving each
instruction itself — `RUN` becomes `vm.run(...)`, `COPY` becomes a directory
sync into the VM. This module is the parse half: text in, an ordered list of
instructions out, with no network and no VM.

Parsing lives client-side because `COPY` is what makes a Dockerfile build
impossible to serve purely server-side — its sources are files on THIS machine,
and only the client can read them.
"""

from __future__ import annotations

import pytest

from arker.build_spec import (
    Add,
    Cmd,
    Copy,
    DockerfileError,
    Entrypoint,
    Env,
    Run,
    User,
    Workdir,
    parse_dockerfile,
)


def test_parses_a_plain_single_stage_dockerfile():
    parsed = parse_dockerfile(
        "FROM ubuntu:24.04\n"
        "RUN apt-get update\n"
        "ENV FOO=bar\n"
        "WORKDIR /app\n"
        "USER root\n"
    )
    assert parsed.base_image == "ubuntu:24.04"
    assert parsed.steps == [
        Run("apt-get update"),
        Env([("FOO", "bar")]),
        Workdir("/app"),
        User("root"),
    ]


def test_comments_and_blank_lines_are_ignored():
    parsed = parse_dockerfile(
        "# leading comment\n"
        "\n"
        "FROM ubuntu:24.04\n"
        "   # indented comment\n"
        "RUN echo hi\n"
    )
    assert parsed.base_image == "ubuntu:24.04"
    assert parsed.steps == [Run("echo hi")]


def test_line_continuations_join_into_one_instruction():
    """The continued line's indentation is preserved verbatim.

    We deliberately do NOT collapse the whitespace: it is insignificant to the
    shell here, but collapsing would corrupt a command where the spaces sit
    inside quotes (`RUN echo "a    b"`). One Run step is what matters.
    """
    parsed = parse_dockerfile(
        "FROM ubuntu:24.04\n"
        "RUN apt-get update \\\n"
        "    && apt-get install -y curl\n"
    )
    assert parsed.steps == [Run("apt-get update     && apt-get install -y curl")]


def test_whitespace_inside_a_quoted_run_argument_is_preserved():
    """The reason the test above does not normalise whitespace."""
    parsed = parse_dockerfile('FROM ubuntu:24.04\nRUN echo "a    b"\n')
    assert parsed.steps == [Run('echo "a    b"')]


def test_instruction_keywords_are_case_insensitive():
    parsed = parse_dockerfile("from ubuntu:24.04\nrun echo hi\n")
    assert parsed.base_image == "ubuntu:24.04"
    assert parsed.steps == [Run("echo hi")]


def test_copy_carries_sources_and_destination():
    parsed = parse_dockerfile("FROM ubuntu:24.04\nCOPY a.txt b.txt /srv/\n")
    assert parsed.steps == [Copy(["a.txt", "b.txt"], "/srv/")]


def test_copy_of_the_whole_context():
    """The single most common COPY line there is."""
    parsed = parse_dockerfile("FROM ubuntu:24.04\nCOPY . /app\n")
    assert parsed.steps == [Copy(["."], "/app")]


def test_copy_chown_is_carried_not_dropped():
    """Docker applies --chown to the written files; silently ignoring it would
    hand back a tree with the wrong owner and no indication why."""
    parsed = parse_dockerfile("FROM ubuntu:24.04\nCOPY --chown=app:app src /app\n")
    assert parsed.steps == [Copy(["src"], "/app", chown="app:app")]


def test_env_line_with_several_pairs_becomes_one_step():
    parsed = parse_dockerfile("FROM ubuntu:24.04\nENV A=1 B=2\n")
    assert parsed.steps == [Env([("A", "1"), ("B", "2")])]


def test_env_legacy_space_form():
    """`ENV key value` — Docker's older single-pair spelling, still common."""
    parsed = parse_dockerfile("FROM ubuntu:24.04\nENV FOO bar baz\n")
    assert parsed.steps == [Env([("FOO", "bar baz")])]


def test_env_quoted_value_keeps_inner_spaces():
    parsed = parse_dockerfile('FROM ubuntu:24.04\nENV GREETING="hello world"\n')
    assert parsed.steps == [Env([("GREETING", "hello world")])]


def test_run_exec_form_becomes_a_quoted_command_line():
    """Exec form has no shell in Docker; our only primitive is a command line,
    so each element is quoted and joined — same argv, via the shell's own
    fork+exec. `shlex.quote` quotes only what needs it, so `echo` stays bare."""
    parsed = parse_dockerfile('FROM ubuntu:24.04\nRUN ["echo", "a b"]\n')
    assert parsed.steps == [Run("echo 'a b'")]


def test_run_exec_form_quotes_shell_metacharacters():
    """The reason quoting happens at all: an argument that looks like shell
    syntax must reach the program as one literal argument."""
    parsed = parse_dockerfile('FROM ubuntu:24.04\nRUN ["echo", "a; rm -rf /"]\n')
    assert parsed.steps == [Run("echo 'a; rm -rf /'")]


def test_add_with_a_url_is_kept_as_a_fetch():
    parsed = parse_dockerfile("FROM ubuntu:24.04\nADD https://example.com/f /f\n")
    assert parsed.steps == [Add("https://example.com/f", "/f")]


def test_entrypoint_and_cmd_are_recorded():
    parsed = parse_dockerfile(
        'FROM ubuntu:24.04\nENTRYPOINT ["/bin/sh"]\nCMD ["-c", "true"]\n'
    )
    assert parsed.steps == [Entrypoint("/bin/sh"), Cmd("-c true")]


def test_rejects_a_dockerfile_with_no_from():
    with pytest.raises(DockerfileError, match="FROM"):
        parse_dockerfile("RUN echo hi\n")


def test_rejects_multi_stage_builds():
    with pytest.raises(DockerfileError, match="multi-stage"):
        parse_dockerfile(
            "FROM ubuntu:24.04 AS build\nRUN echo hi\nFROM alpine:3.20\n"
        )


def test_rejects_cross_stage_copy():
    with pytest.raises(DockerfileError, match="--from"):
        parse_dockerfile("FROM ubuntu:24.04\nCOPY --from=build /a /a\n")


def test_rejects_arg_substituted_from():
    """We resolve FROM through a real image fork, so it must be a literal."""
    with pytest.raises(DockerfileError, match="ARG"):
        parse_dockerfile("ARG BASE=ubuntu:24.04\nFROM ${BASE}\n")


def test_rejects_unsupported_directives_by_name():
    for directive in ["VOLUME /data", "HEALTHCHECK CMD true", "ONBUILD RUN x"]:
        with pytest.raises(DockerfileError, match=directive.split()[0]):
            parse_dockerfile(f"FROM ubuntu:24.04\n{directive}\n")


def test_rejects_copy_with_no_destination():
    with pytest.raises(DockerfileError, match="COPY"):
        parse_dockerfile("FROM ubuntu:24.04\nCOPY onlyone\n")


def test_rejects_empty_input():
    with pytest.raises(DockerfileError):
        parse_dockerfile("   \n\n")
