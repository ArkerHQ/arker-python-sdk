#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CONTRACT_PATH = Path("openapi.json")
TYPESCRIPT_PATH = Path("typescript/src/generated/api-types.ts")
PYTHON_PATH = Path("python/src/arker/generated/api_models.py")
TYPESCRIPT_FORK_PATH = Path("typescript/src/generated/fork.ts")
PYTHON_FORK_PATH = Path("python/src/arker/generated/fork.py")
MANAGED_PATHS = (
    CONTRACT_PATH,
    TYPESCRIPT_PATH,
    TYPESCRIPT_FORK_PATH,
    PYTHON_PATH,
    PYTHON_FORK_PATH,
)
HTTP_METHODS = ("get", "post", "put", "patch", "delete", "options", "head", "trace")
REPO_ROOT = Path(__file__).resolve().parents[1]


class ContractError(RuntimeError):
    pass


def run(
    command: list[str],
    *,
    cwd: Path = REPO_ROOT,
) -> None:
    try:
        subprocess.run(
            command,
            cwd=cwd,
            check=True,
        )
    except FileNotFoundError as error:
        raise ContractError(f"required command not found: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        raise ContractError(
            f"command failed with exit code {error.returncode}: {' '.join(command)}"
        ) from error


def validate_contract(content: bytes) -> None:
    try:
        document = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError("source contract is not valid JSON") from error
    if not isinstance(document, dict) or not isinstance(document.get("openapi"), str):
        raise ContractError("source contract is not an OpenAPI document")


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
        + "\nfrom typing import TypedDict\n\n"
        + "# OpenAPI operation types\n\n"
        + "\n".join(definitions)
        + "\n"
    )


def fork_contract(document: dict[str, object]) -> tuple[str, str, dict[str, object], str]:
    paths = document.get("paths")
    if not isinstance(paths, dict):
        raise ContractError("OpenAPI document has no paths object")
    path = next(
        (
            candidate
            for candidate, item in paths.items()
            if isinstance(item, dict)
            and isinstance(item.get("post"), dict)
            and item["post"].get("operationId") == "fork"
        ),
        None,
    )
    if not isinstance(path, str):
        raise ContractError("OpenAPI document has no fork operation")
    operation = paths[path]["post"]
    request_body = operation.get("requestBody")
    if isinstance(request_body, dict) and isinstance(request_body.get("$ref"), str):
        request_body = resolve_reference(document, request_body["$ref"])
    content = request_body.get("content") if isinstance(request_body, dict) else None
    media = content.get("application/json") if isinstance(content, dict) else None
    schema = media.get("schema") if isinstance(media, dict) else None
    if isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
        schema = resolve_reference(document, schema["$ref"])
    if not isinstance(schema, dict):
        raise ContractError("fork operation has no JSON request schema")
    retry = operation.get("x-arker-retry-window")
    retry_field = retry.get("field") if isinstance(retry, dict) else None
    if not isinstance(retry_field, str) or retry.get("unit") != "seconds":
        raise ContractError("fork operation must declare x-arker-retry-window in seconds")
    if retry_field not in schema.get("properties", {}):
        raise ContractError(f"fork retry-window field is not in ForkRequest: {retry_field}")
    return "POST", path, schema, retry_field


def python_input_type(document: dict[str, object], schema: object) -> str:
    if not isinstance(schema, dict):
        return "Any"
    reference = schema.get("$ref")
    if isinstance(reference, str):
        resolved = resolve_reference(document, reference)
        if isinstance(resolved, dict) and (
            resolved.get("type") == "object" or "properties" in resolved
        ):
            return "Mapping[str, object]"
        return python_input_type(document, resolved)
    intersection = schema.get("allOf")
    if isinstance(intersection, list):
        values = [python_input_type(document, item) for item in intersection]
        if schema.get("nullable") is True:
            values.append("None")
        return union(values)
    alternatives = schema.get("oneOf") or schema.get("anyOf")
    if isinstance(alternatives, list):
        return union([python_input_type(document, item) for item in alternatives])
    schema_kind = schema.get("type")
    if isinstance(schema_kind, list):
        return union(
            [
                python_input_type(document, {**schema, "type": item})
                for item in schema_kind
            ]
        )
    values = schema.get("enum")
    if isinstance(values, list) and values:
        return f"Literal[{', '.join(repr(value) for value in values)}]"
    if schema_kind == "array":
        return f"list[{python_input_type(document, schema.get('items'))}]"
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
    if schema_kind == "object" or "properties" in schema:
        return "Mapping[str, object]"
    return "Any"


def fork_variant_name(required: frozenset[str]) -> str:
    names = {
        frozenset({"source_vm_id"}): "ForkByVmIdOptions",
        frozenset({"source_vm_name"}): "ForkByVmNameOptions",
        frozenset({"source_vm_name", "source_org_id"}): "ForkByVmNameAndOrgIdOptions",
        frozenset({"source_vm_name", "source_org_name"}): "ForkByVmNameAndOrgNameOptions",
        frozenset({"image"}): "ForkByImageOptions",
        frozenset({"dockerfile"}): "ForkByDockerfileOptions",
    }
    try:
        return names[required]
    except KeyError as error:
        raise ContractError(f"unsupported fork source variant: {sorted(required)}") from error


def name_fork_request_variants(output: Path) -> None:
    source = output.read_text()
    replacements: dict[str, str] = {}
    for node in ast.parse(source).body:
        if not isinstance(node, ast.ClassDef) or not re.fullmatch(
            r"ForkRequest\d+", node.name
        ):
            continue
        required = frozenset(
            statement.target.id
            for statement in node.body
            if isinstance(statement, ast.AnnAssign)
            and isinstance(statement.target, ast.Name)
            and statement.value is None
        )
        replacements[node.name] = (
            fork_variant_name(required)
            .replace("ForkBy", "ForkFrom")
            .replace("Options", "Request")
        )
    if len(replacements) != 6:
        raise ContractError("generator did not emit the six expected fork variants")
    for old_name, new_name in replacements.items():
        source = re.sub(rf"\b{old_name}\b", new_name, source)
    output.write_text(source)


def render_python_fork(document: dict[str, object]) -> str:
    method, path, schema, retry_field = fork_contract(document)
    properties = schema.get("properties")
    alternatives = schema.get("oneOf")
    if not isinstance(properties, dict) or not isinstance(alternatives, list):
        raise ContractError("ForkRequest must have properties and oneOf variants")

    variants: list[tuple[str, dict[str, object], frozenset[str]]] = []
    selector_fields: set[str] = set()
    for alternative in alternatives:
        if not isinstance(alternative, dict):
            raise ContractError("ForkRequest oneOf entries must be objects")
        variant_properties = alternative.get("properties")
        required = frozenset(alternative.get("required") or [])
        if not isinstance(variant_properties, dict):
            raise ContractError("ForkRequest oneOf entry has no properties")
        selector_fields.update(variant_properties)
        variants.append((fork_variant_name(required), variant_properties, required))

    shared = {name: value for name, value in properties.items() if name not in selector_fields}
    validation_variants = [
        {
            "required": sorted(required),
            "null_only": sorted(
                name
                for name, value in variant_properties.items()
                if isinstance(value, dict) and value.get("type") == "null"
            ),
        }
        for _, variant_properties, required in variants
    ]

    def fields(values: dict[str, object], required: frozenset[str] = frozenset()) -> list[str]:
        return [
            f"    {name}: {'Required' if name in required else 'NotRequired'}[{python_input_type(document, value)}]"
            for name, value in values.items()
        ] or ["    pass"]

    lines = [
        "# @generated by scripts/openapi_contract.py; do not edit.",
        "from __future__ import annotations",
        "",
        "from collections.abc import Callable, Mapping",
        "from typing import Any, Literal, TypeAlias",
        "from typing_extensions import NotRequired, Required, TypedDict",
        "",
        "",
        "class ForkSharedOptions(TypedDict, total=False):",
        *fields(shared),
        "",
        "",
    ]
    for name, variant_properties, required in variants:
        lines.extend(
            [
                f"class {name}(ForkSharedOptions, total=False):",
                *fields(variant_properties, required),
                "",
                "",
            ]
        )
    variant_names = [name for name, _, _ in variants]
    name_variants = [name for name in variant_names if "VmName" in name]
    lines.extend(
        [
            f"ForkByNameOptions: TypeAlias = {' | '.join(name_variants)}",
            f"ForkOptions: TypeAlias = {' | '.join(variant_names)}",
            "",
            "",
            "class ForkFromVmOptions(ForkSharedOptions):",
            "    pass",
            "",
            "",
            f"FORK_METHOD: Literal[{method!r}] = {method!r}",
            f"FORK_PATH: Literal[{path!r}] = {path!r}",
            f"FORK_RETRY_WINDOW_FIELD = {retry_field!r}",
            f"FORK_FIELDS = frozenset({sorted(properties)!r})",
            f"FORK_VARIANTS = {validation_variants!r}",
            "",
            "",
            "def validate_fork_options(options: Mapping[str, object]) -> None:",
            "    unknown = options.keys() - FORK_FIELDS",
            "    if unknown:",
            "        raise TypeError(f\"unknown fork option: {min(unknown)}\")",
            "    matches = sum(",
            "        all(options.get(name) is not None for name in variant['required'])",
            "        and all(options.get(name) is None for name in variant['null_only'])",
            "        for variant in FORK_VARIANTS",
            "    )",
            "    if matches != 1:",
            "        raise TypeError(\"fork options must match exactly one source variant\")",
            "",
            "",
            "def fork_operation(",
            "    options: Mapping[str, object],",
            "    *,",
            "    request: Callable[..., dict[str, Any]],",
            "    base_url: str,",
            ") -> dict[str, Any]:",
            "    validate_fork_options(options)",
            "    body = dict(options)",
            "    retry_window = body.get(FORK_RETRY_WINDOW_FIELD)",
            "    return request(",
            "        FORK_METHOD,",
            "        FORK_PATH,",
            "        body,",
            "        base_url=base_url,",
            "        max_queueing_s=retry_window if type(retry_window) is int else None,",
            "        preserve_nulls=True,",
            "        retry_window_field=FORK_RETRY_WINDOW_FIELD,",
            "    )",
            "",
        ]
    )
    return "\n".join(lines)


def camel_name(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def encoder_node(
    document: dict[str, object], schema: object, *, references: frozenset[str] = frozenset()
) -> object:
    if not isinstance(schema, dict):
        return None
    reference = schema.get("$ref")
    if isinstance(reference, str):
        if reference in references:
            return None
        return encoder_node(
            document,
            resolve_reference(document, reference),
            references=references | {reference},
        )
    schema_kind = schema.get("type")
    if schema_kind == "array" or (
        isinstance(schema_kind, list) and "array" in schema_kind
    ):
        return {"items": encoder_node(document, schema.get("items"), references=references)}

    properties: dict[str, object] = {}
    own_properties = schema.get("properties")
    if isinstance(own_properties, dict):
        properties.update(own_properties)
    for keyword in ("allOf", "oneOf", "anyOf"):
        alternatives = schema.get(keyword)
        if not isinstance(alternatives, list):
            continue
        for alternative in alternatives:
            if isinstance(alternative, dict) and isinstance(alternative.get("$ref"), str):
                alternative = resolve_reference(document, alternative["$ref"])
            if isinstance(alternative, dict) and isinstance(alternative.get("properties"), dict):
                properties.update(alternative["properties"])
    if not properties and schema_kind != "object":
        return None
    return {
        "properties": {
            camel_name(name): {
                "wire": name,
                "node": encoder_node(document, child, references=references),
            }
            for name, child in properties.items()
        },
        "additional": bool(schema.get("additionalProperties")),
    }


def render_typescript_fork(document: dict[str, object]) -> str:
    method, path, schema, retry_field = fork_contract(document)
    node = json.dumps(encoder_node(document, schema), indent=2, sort_keys=True)
    alternatives = schema.get("oneOf")
    if not isinstance(alternatives, list):
        raise ContractError("ForkRequest must have oneOf variants")
    variants = []
    for alternative in alternatives:
        if not isinstance(alternative, dict):
            raise ContractError("ForkRequest oneOf entries must be objects")
        variant_properties = alternative.get("properties")
        if not isinstance(variant_properties, dict):
            raise ContractError("ForkRequest oneOf entry has no properties")
        variants.append(
            {
                "required": [camel_name(name) for name in alternative.get("required") or []],
                "nullOnly": [
                    camel_name(name)
                    for name, value in variant_properties.items()
                    if isinstance(value, dict) and value.get("type") == "null"
                ],
            }
        )
    variant_node = json.dumps(variants, indent=2, sort_keys=True)
    return f'''// @generated by scripts/openapi_contract.py; do not edit.
import type {{ components }} from "./api-types.js";

type SnakeToCamel<Value extends string> =
  Value extends `${{infer Head}}_${{infer Tail}}`
    ? `${{Head}}${{Capitalize<SnakeToCamel<Tail>>}}`
    : Value;

type Camelize<Value> =
  Value extends readonly (infer Item)[] ? Camelize<Item>[] :
  Value extends object ? {{
    [Key in keyof Value as Key extends string ? SnakeToCamel<Key> : Key]: Camelize<Value[Key]>
  }} : Value;

type ForkWireRequest = components["schemas"]["ForkRequest"];
export type ForkOptions = Camelize<ForkWireRequest>;
export type ForkByVmIdOptions = Extract<ForkOptions, {{ sourceVmId: string }}>;
export type ForkByVmNameOptions = Extract<ForkOptions, {{
  sourceVmName: string;
  sourceOrgId?: null;
  sourceOrgName?: null;
}}>;
export type ForkByVmNameAndOrgIdOptions = Extract<ForkOptions, {{ sourceOrgId: string }}>;
export type ForkByVmNameAndOrgNameOptions = Extract<ForkOptions, {{ sourceOrgName: string }}>;
export type ForkByNameOptions =
  | ForkByVmNameOptions
  | ForkByVmNameAndOrgIdOptions
  | ForkByVmNameAndOrgNameOptions;
export type ForkByImageOptions = Extract<ForkOptions, {{ image: string }}>;
export type ForkByDockerfileOptions = Extract<ForkOptions, {{ dockerfile: string }}>;
export type ForkFromVmOptions = Omit<ForkByVmIdOptions, "sourceVmId">;

type EncoderNode = null | {{
  properties?: Record<string, {{ wire: string; node: EncoderNode }}>;
  additional?: boolean;
  items?: EncoderNode;
}};

const FORK_ENCODER: EncoderNode = {node};
const FORK_VARIANTS = {variant_node} as const;
export const FORK_RETRY_WINDOW_FIELD = {json.dumps(retry_field)};

function assertForkOptions(options: unknown): asserts options is Record<string, unknown> {{
  if (options === null || typeof options !== "object" || Array.isArray(options)) {{
    throw new TypeError("fork options must be an object");
  }}
  const values = options as Record<string, unknown>;
  const matches = FORK_VARIANTS.filter((variant) =>
    variant.required.every((name) => values[name] !== null && values[name] !== undefined) &&
    variant.nullOnly.every((name) => values[name] === null || values[name] === undefined)
  ).length;
  if (matches !== 1) {{
    throw new TypeError("fork options must match exactly one source variant");
  }}
}}

function encode(value: unknown, node: EncoderNode, path = "fork"): unknown {{
  if (value === null || value === undefined || node === null) return value;
  if (node.items !== undefined) {{
    return Array.isArray(value)
      ? value.map((item, index) => encode(item, node.items ?? null, `${{path}}[${{index}}]`))
      : value;
  }}
  if (typeof value !== "object" || Array.isArray(value)) return value;
  const output: Record<string, unknown> = {{}};
  for (const [name, item] of Object.entries(value)) {{
    if (item === undefined) continue;
    const property = node.properties?.[name];
    if (property) {{
      output[property.wire] = encode(item, property.node, `${{path}}.${{name}}`);
    }} else if (node.additional) {{
      output[name] = item;
    }} else {{
      throw new TypeError(`unknown ${{path}} option: ${{name}}`);
    }}
  }}
  return output;
}}

export function encodeForkRequest(options: ForkOptions): ForkWireRequest {{
  assertForkOptions(options);
  return encode(options, FORK_ENCODER) as ForkWireRequest;
}}

export type ForkSender = <Response>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  baseUrl: string,
  extraHeaders?: Record<string, string | undefined>,
  maxQueueingSecs?: number,
  retryWindowField?: string,
  preserveBody?: boolean,
) => Promise<Response>;

export async function forkOperation(
  options: ForkOptions,
  baseUrl: string,
  send: ForkSender,
): Promise<components["schemas"]["Vm"]> {{
  const body = encodeForkRequest(options) as Record<string, unknown>;
  const retryWindow = body[FORK_RETRY_WINDOW_FIELD];
  return send(
    {json.dumps(method)},
    {json.dumps(path)},
    body,
    baseUrl,
    undefined,
    typeof retryWindow === "number" ? retryWindow : undefined,
    FORK_RETRY_WINDOW_FIELD,
    true,
  );
}}
'''


def generate_fork_runtime(contract: Path, output_root: Path) -> None:
    document = json.loads(contract.read_text())
    python_output = output_root / PYTHON_FORK_PATH
    typescript_output = output_root / TYPESCRIPT_FORK_PATH
    python_output.parent.mkdir(parents=True, exist_ok=True)
    typescript_output.parent.mkdir(parents=True, exist_ok=True)
    python_output.write_text(render_python_fork(document))
    typescript_output.write_text(render_typescript_fork(document))


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
            "--enum-field-as-literal",
            "all",
            "--frozen-dataclasses",
            "--disable-timestamp",
            "--include-path-parameters",
        ],
    )
    name_fork_request_variants(python_output)
    append_operation_types(contract, python_output)
    generate_fork_runtime(contract, output_root)


def stage_contract(output_root: Path, contract: bytes) -> None:
    contract_output = output_root / CONTRACT_PATH
    contract_output.parent.mkdir(parents=True, exist_ok=True)
    contract_output.write_bytes(contract)
    generate(contract_output, output_root)


def copy_managed_files(source_root: Path, output_root: Path) -> None:
    for relative_path in MANAGED_PATHS:
        source = source_root / relative_path
        destination = output_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.tmp")
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)


def load_vendored_source() -> bytes:
    try:
        contract = (REPO_ROOT / CONTRACT_PATH).read_bytes()
    except FileNotFoundError as error:
        raise ContractError(f"vendored contract is missing: {CONTRACT_PATH}") from error
    validate_contract(contract)
    return contract


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
    source = Path(args.source_file).resolve()
    try:
        contract = source.read_bytes()
    except FileNotFoundError as error:
        raise ContractError(f"source contract not found: {source}") from error
    validate_contract(contract)

    output_root = Path(args.output_root).resolve()
    with tempfile.TemporaryDirectory(prefix="arker-openapi-sync-") as directory:
        stage = Path(directory)
        stage_contract(stage, contract)
        copy_managed_files(stage, output_root)

    print(f"synced {CONTRACT_PATH} from {source}")
    return 0


def command_check(args: argparse.Namespace) -> int:
    contract = load_vendored_source()

    with tempfile.TemporaryDirectory(prefix="arker-openapi-check-") as directory:
        expected_root = Path(directory)
        stage_contract(expected_root, contract)
        expected = {path: (expected_root / path).read_bytes() for path in MANAGED_PATHS}

    actual = local_candidate(Path(args.candidate_root or REPO_ROOT).resolve())

    drift = False
    for relative_path in MANAGED_PATHS:
        if actual[relative_path] != expected[relative_path]:
            print_diff(relative_path, expected[relative_path], actual[relative_path])
            drift = True
    if drift:
        return 1

    print("generated artifacts match openapi.json")
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
    sync_parser.add_argument("--source-file", required=True)
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
