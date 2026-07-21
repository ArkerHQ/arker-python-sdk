#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPOSITORY = "ArkerHQ/arker-app"
REF = "main"
CONTRACT_PATH = Path("contract/openapi.json")
METADATA_PATH = Path("contract/source.json")
TYPESCRIPT_PATH = Path("typescript/src/generated/api-types.ts")
PYTHON_PATH = Path("python/src/arker/generated/api_models.py")
MANAGED_PATHS = (CONTRACT_PATH, METADATA_PATH, TYPESCRIPT_PATH, PYTHON_PATH)
MAX_CANDIDATE_BYTES = 5 * 1024 * 1024
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
REPO_ROOT = Path(__file__).resolve().parents[1]


class ContractError(RuntimeError):
    pass


def run(
    command: list[str],
    *,
    cwd: Path = REPO_ROOT,
    capture_bytes: bool = False,
    strip_tokens: bool = False,
) -> str | bytes:
    environment = os.environ.copy()
    if strip_tokens:
        environment.pop("GH_TOKEN", None)
        environment.pop("GITHUB_TOKEN", None)
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=environment,
            check=True,
            stdout=subprocess.PIPE if capture_bytes else None,
            stderr=None,
        )
    except FileNotFoundError as error:
        raise ContractError(f"required command not found: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        raise ContractError(
            f"command failed with exit code {error.returncode}: {' '.join(command)}"
        ) from error

    if not capture_bytes:
        return ""
    return result.stdout


def capture_text(command: list[str]) -> str:
    output = run(command, capture_bytes=True)
    assert isinstance(output, bytes)
    return output.decode().strip()


def validate_commit(commit: str) -> str:
    normalized = commit.strip().lower()
    if not COMMIT_PATTERN.fullmatch(normalized):
        raise ContractError(f"invalid source commit: {commit!r}")
    return normalized


def validate_contract(content: bytes) -> None:
    try:
        document = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError("source contract is not valid JSON") from error
    if not isinstance(document, dict) or not isinstance(document.get("openapi"), str):
        raise ContractError("source contract is not an OpenAPI document")


def fetch_source() -> tuple[str, bytes]:
    commit = validate_commit(
        capture_text(["gh", "api", f"repos/{REPOSITORY}/commits/{REF}", "--jq", ".sha"])
    )
    content = run(
        [
            "gh",
            "api",
            "-H",
            "Accept: application/vnd.github.raw+json",
            f"repos/{REPOSITORY}/contents/openapi.json?ref={commit}",
        ],
        capture_bytes=True,
    )
    assert isinstance(content, bytes)
    validate_contract(content)
    return commit, content


def metadata_bytes(commit: str, contract: bytes) -> bytes:
    document = {
        "repository": REPOSITORY,
        "ref": REF,
        "commit": validate_commit(commit),
        "sha256": hashlib.sha256(contract).hexdigest(),
    }
    return (json.dumps(document, indent=2) + "\n").encode()


def generate(contract: Path, output_root: Path) -> None:
    contract = contract.resolve()
    validate_contract(contract.read_bytes())

    typescript_output = output_root / TYPESCRIPT_PATH
    python_output = output_root / PYTHON_PATH
    typescript_output.parent.mkdir(parents=True, exist_ok=True)
    python_output.parent.mkdir(parents=True, exist_ok=True)

    typescript_generator = REPO_ROOT / "typescript/node_modules/.bin/openapi-typescript"
    if not typescript_generator.is_file():
        raise ContractError(
            "TypeScript dependencies are missing; run `npm ci` in typescript/"
        )

    run(
        [
            str(typescript_generator),
            str(contract),
            "--default-non-nullable",
            "false",
            "-o",
            str(typescript_output),
        ],
        strip_tokens=True,
    )
    run(
        [
            "uv",
            "run",
            "--project",
            str(REPO_ROOT / "python"),
            "datamodel-codegen",
            "--input",
            str(contract),
            "--input-file-type",
            "openapi",
            "--output",
            str(python_output),
            "--output-model-type",
            "dataclasses.dataclass",
            "--target-python-version",
            "3.10",
            "--openapi-scopes",
            "schemas",
            "paths",
            "parameters",
            "--use-operation-id-as-name",
            "--use-standard-collections",
            "--use-union-operator",
            "--disable-timestamp",
        ],
        strip_tokens=True,
    )


def stage_contract(output_root: Path, commit: str, contract: bytes) -> None:
    contract_output = output_root / CONTRACT_PATH
    metadata_output = output_root / METADATA_PATH
    contract_output.parent.mkdir(parents=True, exist_ok=True)
    contract_output.write_bytes(contract)
    metadata_output.write_bytes(metadata_bytes(commit, contract))
    generate(contract_output, output_root)


def copy_managed_files(source_root: Path, output_root: Path) -> None:
    for relative_path in MANAGED_PATHS:
        source = source_root / relative_path
        destination = output_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.tmp")
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)


def load_offline_source() -> tuple[str, bytes]:
    try:
        metadata = json.loads((REPO_ROOT / METADATA_PATH).read_text())
        commit = validate_commit(metadata["commit"])
        contract = (REPO_ROOT / CONTRACT_PATH).read_bytes()
    except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ContractError("offline source metadata is missing or invalid") from error
    validate_contract(contract)
    return commit, contract


def remote_candidate(repository: str, ref: str) -> dict[Path, bytes]:
    if not REPOSITORY_PATTERN.fullmatch(repository):
        raise ContractError(f"invalid candidate repository: {repository!r}")
    commit = validate_commit(ref)
    candidate: dict[Path, bytes] = {}
    for relative_path in MANAGED_PATHS:
        path = urllib.parse.quote(str(relative_path), safe="/")
        url = f"https://raw.githubusercontent.com/{repository}/{commit}/{path}"
        request = urllib.request.Request(
            url, headers={"User-Agent": "arker-openapi-check"}
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                content = response.read(MAX_CANDIDATE_BYTES + 1)
                if len(content) > MAX_CANDIDATE_BYTES:
                    raise ContractError(f"candidate {relative_path} exceeds 5 MiB")
                candidate[relative_path] = content
        except urllib.error.HTTPError as error:
            if error.code == 404:
                candidate[relative_path] = b""
                continue
            raise ContractError(
                f"failed to fetch candidate {relative_path}: HTTP {error.code}"
            ) from error
        except urllib.error.URLError as error:
            raise ContractError(
                f"failed to fetch candidate {relative_path}: {error.reason}"
            ) from error
    return candidate


def local_candidate(root: Path) -> dict[Path, bytes]:
    candidate: dict[Path, bytes] = {}
    for relative_path in MANAGED_PATHS:
        path = root / relative_path
        candidate[relative_path] = path.read_bytes() if path.is_file() else b""
    return candidate


def print_diff(relative_path: Path, expected: bytes, actual: bytes) -> None:
    try:
        expected_text = expected.decode().splitlines(keepends=True)
        actual_text = actual.decode().splitlines(keepends=True)
    except UnicodeDecodeError:
        print(f"drift detected: {relative_path} differs", file=sys.stderr)
        return

    print(f"drift detected: {relative_path}", file=sys.stderr)
    diff = difflib.unified_diff(
        actual_text,
        expected_text,
        fromfile=f"candidate/{relative_path}",
        tofile=f"expected/{relative_path}",
    )
    sys.stderr.writelines(diff)


def command_generate(args: argparse.Namespace) -> int:
    generate(Path(args.contract), Path(args.output_root).resolve())
    return 0


def command_sync(args: argparse.Namespace) -> int:
    if args.source_file:
        if not args.source_commit:
            raise ContractError("--source-commit is required with --source-file")
        commit = validate_commit(args.source_commit)
        contract = Path(args.source_file).read_bytes()
        validate_contract(contract)
    elif args.source_commit:
        raise ContractError("--source-commit requires --source-file")
    else:
        commit, contract = fetch_source()

    output_root = Path(args.output_root).resolve()
    with tempfile.TemporaryDirectory(prefix="arker-openapi-sync-") as directory:
        stage = Path(directory)
        stage_contract(stage, commit, contract)
        copy_managed_files(stage, output_root)

    print(f"synced {REPOSITORY}@{commit} ({hashlib.sha256(contract).hexdigest()})")
    return 0


def command_check(args: argparse.Namespace) -> int:
    if args.offline:
        commit, contract = load_offline_source()
    else:
        commit, contract = fetch_source()

    if bool(args.candidate_repository) != bool(args.candidate_ref):
        raise ContractError(
            "--candidate-repository and --candidate-ref must be provided together"
        )
    if args.candidate_root and args.candidate_repository:
        raise ContractError(
            "--candidate-root cannot be combined with a remote candidate"
        )

    with tempfile.TemporaryDirectory(prefix="arker-openapi-check-") as directory:
        expected_root = Path(directory)
        stage_contract(expected_root, commit, contract)
        expected = {path: (expected_root / path).read_bytes() for path in MANAGED_PATHS}

    if args.candidate_repository:
        actual = remote_candidate(args.candidate_repository, args.candidate_ref)
    else:
        actual = local_candidate(Path(args.candidate_root or REPO_ROOT).resolve())

    drift = False
    for relative_path in MANAGED_PATHS:
        if actual[relative_path] != expected[relative_path]:
            print_diff(relative_path, expected[relative_path], actual[relative_path])
            drift = True
    if drift:
        return 1

    print(f"OpenAPI contract is current at {REPOSITORY}@{commit}")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Synchronize and verify the public OpenAPI contract"
    )
    subcommands = root.add_subparsers(dest="command", required=True)

    generate_parser = subcommands.add_parser("generate")
    generate_parser.add_argument("--contract", required=True)
    generate_parser.add_argument("--output-root", default=str(REPO_ROOT))
    generate_parser.set_defaults(handler=command_generate)

    sync_parser = subcommands.add_parser("sync")
    sync_parser.add_argument("--source-file")
    sync_parser.add_argument("--source-commit")
    sync_parser.add_argument("--output-root", default=str(REPO_ROOT))
    sync_parser.set_defaults(handler=command_sync)

    check_parser = subcommands.add_parser("check")
    check_parser.add_argument("--offline", action="store_true")
    check_parser.add_argument("--candidate-root")
    check_parser.add_argument("--candidate-repository")
    check_parser.add_argument("--candidate-ref")
    check_parser.set_defaults(handler=command_check)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return args.handler(args)
    except ContractError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
