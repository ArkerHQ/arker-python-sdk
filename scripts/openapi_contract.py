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
from pathlib import Path

REPOSITORY = "ArkerHQ/arker-app"
REF = "main"
CONTRACT_PATH = Path("contract/openapi.json")
METADATA_PATH = Path("contract/source.json")
TYPESCRIPT_PATH = Path("typescript/src/generated/api-types.ts")
PYTHON_PATH = Path("python/src/arker/generated/api_models.py")
MANAGED_PATHS = (CONTRACT_PATH, METADATA_PATH, TYPESCRIPT_PATH, PYTHON_PATH)
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
HTTP_METHODS = ("get", "post", "put", "patch", "delete", "options", "head", "trace")
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


def resolve_reference(document: dict[str, object], reference: str) -> object:
    if not reference.startswith("#/"):
        raise ContractError(f"unsupported external OpenAPI reference: {reference}")
    value: object = document
    for raw_part in reference[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or part not in value:
            raise ContractError(f"unresolved OpenAPI reference: {reference}")
        value = value[part]
    return value


def model_name(value: str) -> str:
    words = re.split(r"[^A-Za-z0-9]+", value)
    name = "".join(word[:1].upper() + word[1:] for word in words if word)
    if not name or name[0].isdigit():
        raise ContractError(f"operationId cannot form a Python model name: {value!r}")
    return name


def schema_type(
    document: dict[str, object], schema: object, *, inline_name: str
) -> str:
    if not isinstance(schema, dict):
        return "None"
    reference = schema.get("$ref")
    if isinstance(reference, str):
        return reference.rsplit("/", 1)[-1]

    alternatives = schema.get("oneOf") or schema.get("anyOf")
    if isinstance(alternatives, list):
        types = [
            schema_type(document, alternative, inline_name=inline_name)
            for alternative in alternatives
        ]
        return " | ".join(dict.fromkeys(types))

    schema_kind = schema.get("type")
    if isinstance(schema_kind, list):
        types = [
            schema_type(document, {**schema, "type": kind}, inline_name=inline_name)
            for kind in schema_kind
        ]
        return " | ".join(dict.fromkeys(types))
    if schema_kind == "array":
        return f"list[{schema_type(document, schema.get('items'), inline_name=inline_name)}]"
    if schema_kind == "string":
        return "str"
    if schema_kind == "integer":
        return "int"
    if schema_kind == "number":
        return "float"
    if schema_kind == "boolean":
        return "bool"
    if schema_kind == "null":
        return "None"
    if schema_kind == "object" and "properties" not in schema:
        additional = schema.get("additionalProperties")
        value_type = (
            schema_type(document, additional, inline_name=inline_name)
            if isinstance(additional, dict)
            else "Any"
        )
        return f"dict[str, {value_type}]"
    return inline_name


def response_type(
    document: dict[str, object], response: object, *, inline_name: str
) -> str:
    if isinstance(response, dict) and isinstance(response.get("$ref"), str):
        response = resolve_reference(document, response["$ref"])
    if not isinstance(response, dict):
        return "None"
    content = response.get("content")
    if not isinstance(content, dict):
        return "None"
    media = content.get("application/json")
    if not isinstance(media, dict):
        return "None"
    return schema_type(document, media.get("schema"), inline_name=inline_name)


def union(types: list[str]) -> str:
    unique = list(dict.fromkeys(types))
    return " | ".join(unique) if unique else "None"


def append_operation_types(contract: Path, output: Path) -> None:
    document = json.loads(contract.read_text())
    paths = document.get("paths")
    if not isinstance(paths, dict):
        raise ContractError("OpenAPI document has no paths object")

    definitions: list[str] = []
    operation_names: list[str] = []
    operation_ids: set[str] = set()
    for path in sorted(paths):
        path_item = paths[path]
        if not isinstance(path_item, dict):
            continue
        for method in HTTP_METHODS:
            operation = path_item.get(method)
            if not isinstance(operation, dict):
                continue
            operation_id = operation.get("operationId")
            if not isinstance(operation_id, str) or not operation_id:
                raise ContractError(f"{method.upper()} {path} has no operationId")
            if operation_id in operation_ids:
                raise ContractError(f"duplicate operationId: {operation_id}")
            operation_ids.add(operation_id)

            prefix = model_name(operation_id)
            operation_name = f"{prefix}Operation"
            operation_names.append(operation_name)
            parameters = [
                *(path_item.get("parameters") or []),
                *(operation.get("parameters") or []),
            ]
            parameter_type = f"{prefix}Parameters" if parameters else "None"

            request_body = operation.get("requestBody")
            if isinstance(request_body, dict) and isinstance(
                request_body.get("$ref"), str
            ):
                request_body = resolve_reference(document, request_body["$ref"])
            request_content = (
                request_body.get("content") if isinstance(request_body, dict) else None
            )
            request_media = (
                request_content.get("application/json")
                if isinstance(request_content, dict)
                else None
            )
            request_type = (
                schema_type(
                    document,
                    request_media.get("schema"),
                    inline_name=f"{prefix}Request",
                )
                if isinstance(request_media, dict)
                else "None"
            )
            if (
                request_type != "None"
                and isinstance(request_body, dict)
                and request_body.get("required") is not True
            ):
                request_type = union([request_type, "None"])

            responses = operation.get("responses")
            if not isinstance(responses, dict):
                raise ContractError(f"{method.upper()} {path} has no responses")
            success_types: list[str] = []
            error_types: list[str] = []
            for status, response in responses.items():
                response_model = response_type(
                    document, response, inline_name=f"{prefix}Response"
                )
                if status.isdigit() and 100 <= int(status) < 400:
                    success_types.append(response_model)
                else:
                    error_types.append(response_model)

            definitions.extend(
                [
                    f"class {operation_name}(TypedDict):",
                    f"    operation_id: Literal[{operation_id!r}]",
                    f"    method: Literal[{method.upper()!r}]",
                    f"    path: Literal[{path!r}]",
                    f"    parameters: {parameter_type}",
                    f"    request: {request_type}",
                    f"    success: {union(success_types)}",
                    f"    errors: {union(error_types)}",
                    "",
                    "",
                ]
            )

    definitions.append("ApiOperation: TypeAlias = (")
    definitions.extend(f"    {name} |" for name in operation_names[:-1])
    definitions.append(f"    {operation_names[-1]}")
    definitions.append(")")
    output.write_text(
        output.read_text()
        + "\n# OpenAPI operation types\n\n"
        + "\n".join(definitions)
        + "\n"
    )


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
            "TypeScript dependencies are missing; run `bun ci` in typescript/"
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
            "typing.TypedDict",
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
            "--include-path-parameters",
        ],
        strip_tokens=True,
    )
    append_operation_types(contract, python_output)


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


def load_vendored_source() -> tuple[str, bytes]:
    try:
        metadata = json.loads((REPO_ROOT / METADATA_PATH).read_text())
        commit = validate_commit(metadata["commit"])
        contract = (REPO_ROOT / CONTRACT_PATH).read_bytes()
    except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ContractError("vendored source metadata is missing or invalid") from error
    validate_contract(contract)
    return commit, contract


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
    commit, contract = load_vendored_source()

    with tempfile.TemporaryDirectory(prefix="arker-openapi-check-") as directory:
        expected_root = Path(directory)
        stage_contract(expected_root, commit, contract)
        expected = {path: (expected_root / path).read_bytes() for path in MANAGED_PATHS}

    actual = local_candidate(Path(args.candidate_root or REPO_ROOT).resolve())

    drift = False
    for relative_path in MANAGED_PATHS:
        if actual[relative_path] != expected[relative_path]:
            print_diff(relative_path, expected[relative_path], actual[relative_path])
            drift = True
    if drift:
        return 1

    print(
        "generated artifacts match contract/openapi.json "
        f"(synchronized from {REPOSITORY}@{commit})"
    )
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
    check_parser.add_argument("--candidate-root")
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
