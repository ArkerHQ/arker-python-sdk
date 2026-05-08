# Ubuntu API Compliance Handoff

## Goal

Make the normal/ubuntu backend (`arkerd`, served at `https://aws-us-west-2.arker.ai`) comply with the public SDK API contract in `arker-sdk/contract/openapi.json`.

Do **not** merge `codex/api-contract-types` wholesale. That branch contains useful reference work, but also unrelated console/routing/WorkOS changes and does not merge cleanly into current `main`.

The minimum target is: the SDK can use `region: "aws-us-west-2"` and source `"ubuntu"` for fork, run, sync, and delete without adapters or backend-specific special cases.

## Scope

Repo: `/Users/willhunt/codebase/arker-app`

Backend: `aws/arkerd`

Spec source of truth: `/Users/willhunt/codebase/arker-sdk/contract/openapi.json`

Reference branch only: `/Users/willhunt/codebase/arker-api-contract-types`, branch `codex/api-contract-types`

## Principle

Keep the internal arkerd model unchanged where possible. This should mostly be an API-boundary serialization/deserialization fix:

- Internally, arkerd can keep `session_idx`, internal session UUIDs, host IDs, route hints, etc.
- Public responses should match the OpenAPI contract.
- Public requests should accept the OpenAPI contract.
- If preserving current drift is necessary for internal callers, gate it behind a private/internal path or a temporary compatibility header. Do not put non-contract fields in the default public response.

## Required Changes

### 1. VM identifiers

Public API must use `vm_id`, not `id`.

Change arkerd public response structs/builders for:

- `GET /v1/vms`
- `GET /v1/vms/{vm_id}`
- `POST /v1/vms/{source}/fork`
- `GET /v1/goldens`

Expected contract examples:

```json
{
  "vm_id": "vmh-...",
  "owner_id": "01...",
  "created_at": "2026-05-08T18:23:45.166+00:00",
  "state": "suspended",
  "sessions": []
}
```

Fork must return at least:

```json
{
  "vm_id": "vmh-...",
  "owner_id": "01...",
  "created_at": "2026-05-08T18:23:45.166+00:00",
  "sessions": []
}
```

Current live drift:

- Fork returns `id`, not `vm_id`.
- Fork omits `owner_id`.
- VM list/get return `id`, not `vm_id`.
- Goldens return `id`, not `vm_id`.

### 2. Session identifiers

Public API must use `session_id`.

Do not expose `session_idx` in public SDK responses.

Affected responses:

- VM info sessions
- Fork response sessions
- `GET /v1/vms/{vm_id}/sessions`
- `POST /v1/vms/{vm_id}/sessions`
- PTY run response, if applicable

Expected public session shape:

```json
{
  "session_id": "01...",
  "state": "idle",
  "cwd": "/home/user"
}
```

Implementation note:

- Internally, arkerd can still route to shells by `session_idx`.
- When a public request supplies `session_id`, resolve it to the internal session row and use that row's `session_idx`.
- If no `session_id` is supplied, use the default session as today.
- Keeping `session_idx` accepted as a deprecated request alias is okay, but the default public response should be contract-shaped.

Current live drift:

```json
{
  "id": "01...",
  "session_idx": 0,
  "state": "idle",
  "cwd": "/home/user"
}
```

### 3. Run request

OpenAPI requires `command`.

Current arkerd has `#[serde(default)] command: String`, which accepts missing command as an empty string.

Minimum fix:

- Remove the default from the public `RunRequest.command`.
- Keep release-only behavior by requiring callers to pass `"command": ""` explicitly when doing a release-only request.
- Add public `session_id?: string | null`.
- Resolve public `session_id` to internal `session_idx` before execution.

### 4. Completed run response

Completed run responses must include encodings.

Expected:

```json
{
  "stdout": "hello\n",
  "stdout_encoding": "utf-8",
  "stderr": "",
  "stderr_encoding": "utf-8",
  "exit_code": 0,
  "completed": true
}
```

Current live drift:

```json
{
  "stdout": "hello\n",
  "stderr": "",
  "exit_code": 0,
  "completed": true
}
```

Minimum fix:

- For arkerd string stdout/stderr, set both encodings to `"utf-8"`.
- Apply this to all completed-return paths, including release-only completed responses.

### 5. Run status response

`GET /v1/vms/{vm_id}/runs/{run_id}` must include:

- `stdout_encoding`
- `stderr_encoding`

Expected:

```json
{
  "run_id": "01...",
  "stdout": "hello\n",
  "stdout_encoding": "utf-8",
  "stderr": "",
  "stderr_encoding": "utf-8",
  "exit_code": 0,
  "completed": true,
  "tunnels": []
}
```

Current live drift omits both encoding fields.

### 6. Sync inline write request

The contract inline write shape includes `upload_id`:

```json
{
  "op": "write",
  "writes": [
    {
      "path": "/home/user/file.txt",
      "size": 6,
      "upload_id": "01...",
      "content": "aGVsbG8K",
      "start": 0,
      "end": 6
    }
  ]
}
```

Current arkerd parser rejects `content + upload_id` as invalid. It only accepts inline writes when `content` is present and `upload_id` is absent.

Minimum fix:

- Accept `content + upload_id + start + end` as an inline chunk.
- Use the supplied `upload_id` for the chunk session.
- Optionally continue accepting the old no-`upload_id` inline shape by deriving the upload id, but the contract shape must work.

Code area to inspect:

- `aws/arkerd/src/api/routes.rs`
- `parse_sync_request`
- `ParsedInlineWrite`
- inline branch in `sync_vm_fs`

### 7. Error envelope

Public errors should be flat:

```json
{
  "code": "not_found",
  "message": "VM not found"
}
```

Current arkerd drift is often:

```json
{
  "error": "VM not found",
  "code": "not_found"
}
```

Minimum fix:

- Change `ApiError::into_response` to emit `{ code, message }`.
- Update auth rejection helpers that construct `ErrorResponse`.
- Keep HTTP status codes unchanged.

### 8. Delete and cancel

Normal arkerd already looks okay here:

- `DELETE /v1/vms/{vm_id}` returns `{ "deleted": true }`
- `DELETE /v1/vms/{vm_id}/runs/{run_id}` returns `{ "cancelled": true }`

Keep these shapes unchanged.

### 9. Runtime issues that are not just contract drift

Live ubuntu foreground run currently can fail with:

```text
shim not installed at /usr/local/lib/arker/lib/shim_ipc.so
```

That is an image/runtime bug, not an SDK or JSON-shape issue. The SDK cannot be considered end-to-end good for ubuntu until this is fixed.

Live sync also produced an internal filesystem error after bypassing the parser issue:

```text
Structure needs cleaning (os error 117)
```

Re-test sync after fixing the parser. If this still reproduces, it is a separate backend/runtime filesystem bug.

## Files Likely To Touch

Primary:

- `aws/arkerd/src/api/types.rs`
- `aws/arkerd/src/api/routes.rs`
- `aws/arkerd/src/api/auth.rs`

Possibly:

- `aws/arkerd/src/api/ws.rs` if PTY/session response shapes are affected
- `aws/arkerd/src/session/*` only if session lookup helpers are missing
- ubuntu golden/image build files for the missing shim issue

Avoid broad changes in:

- Cloudflare console UI
- WorkOS/member sync
- infrastructure DNS/routing
- regional database plumbing

## Acceptance Criteria

From `/Users/willhunt/codebase/arker-sdk/typescript`:

```bash
ARKER_API_KEY=ark_live_... \
ARKER_BASE_URL=https://aws-us-west-2.arker.ai \
ARKER_SOURCE_VM=ubuntu \
npm run smoke
```

This raw HTTP smoke must pass. It checks:

- fork response shape
- completed run response shape
- sync write shape
- sync read shape

Then run SDK demos with region routing:

```bash
ARKER_API_KEY=ark_live_... \
ARKER_REGION=aws-us-west-2 \
ARKER_SOURCE_VM=ubuntu \
npm run demo
```

From `/Users/willhunt/codebase/arker-sdk/python`:

```bash
PYTHONPATH=src \
ARKER_API_KEY=ark_live_... \
ARKER_REGION=aws-us-west-2 \
ARKER_SOURCE_VM=ubuntu \
python3 tests/demo.py
```

Expected result:

- Fork succeeds.
- Run succeeds.
- Sync write/read succeeds.
- Delete succeeds.
- No SDK adapters or backend-specific special cases are needed.

## Non-Goals

- Do not make burst/arkuntu compliant in this task.
- Do not merge `codex/api-contract-types` wholesale.
- Do not redesign routing.
- Do not change the SDK to tolerate drift.
- Do not add a new public API shape.

## Useful Reference

The previous shared-contract branch has useful examples but should be copied selectively:

```bash
cd /Users/willhunt/codebase/arker-api-contract-types
git log --oneline -8
```

Relevant commits:

- `1f1efec3e Add shared API contract crate`
- `e6464dbb1 Expand shared VM API contract surface`
- `d3e04a4f7 Use explicit VM identifiers in shared contract`
- `b47915458 Use session_id in VM API contract`
- `c03ea5040 Conservatively unify VM API contract`
- `67aff6309 Require run command in shared contract`

Use these as reference only. Port the minimum arkerd changes needed to satisfy `arker-sdk/contract/openapi.json`.
