/**
 * Drop-in compatibility shim for the daytona TypeScript SDK, backed by Arker VMs.
 *
 * Canonical usage:
 *
 *     import { Daytona, CreateSandboxFromSnapshotParams } from "@arker-ai/sdk/daytona";
 *
 *     const daytona = new Daytona({ apiKey: "ark_live_..." });
 *     const sbx = await daytona.create({ snapshot: "py-base", envVars: { FOO: "bar" } });
 *     const resp = await sbx.process.exec("echo $FOO");
 *     for (const s of (await daytona.list()).items) await daytona.delete(s);
 *
 * Pending work (mirrors `python/src/arker/daytona/__init__.py`):
 *
 *   1. Server-side env vars / labels — local-only.
 *   2. start / stop / archive — no-op (Arker has no stopped state).
 *   3. SSH access / preview links / resize / auto-stop intervals — not implemented.
 *   4. Jupyter-style state across `process.codeRun` — per-call subprocess only.
 *   5. PTY sessions (createPtySession, etc.) — throw (need WS client).
 *   6. `process.getEntrypointSession`, `getEntrypointLogs*`,
 *      `getSessionCommandLogsAsync`, `sendSessionCommandInput` — throw.
 *   7. `fs.searchFiles`, `fs.replaceInFiles`, batch upload/download, stream
 *      upload/download — throw.
 *   8. `git`, `lsp`, `computerUse`, `codeInterpreter` sub-namespaces — not implemented.
 *   9. `deleteSession` is local-only (Arker SDK doesn't expose session-delete).
 *  10. sandbox id format (Arker ULIDs vs daytona's IDs) — cannot fix in shim.
 *  11. `findFiles` regex flavor: we use grep -E (POSIX ERE); daytona uses RE2.
 *      `\d` won't match against our shim.
 */

export { Daytona, type LegacyCreateOpts } from "./client.js";
export { Sandbox } from "./sandbox.js";
export { Process, type ExecOpts, wrapCommand } from "./process.js";
export { FileSystem } from "./files.js";
export {
  type Chart,
  type CodeRunParams,
  type Command,
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type DaytonaConfig,
  DaytonaAuthenticationError,
  DaytonaAuthorizationError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
  DaytonaValidationError,
  type ExecuteResponse,
  type ExecutionArtifacts,
  type FileInfo,
  FileSystemError,
  type Match,
  PaginatedSandboxes,
  ProcessError,
  type ReplaceResult,
  SandboxNotFoundError,
  SandboxState,
  type SearchFilesResponse,
  type Session,
  type SessionCommandLogsResponse,
  type SessionExecuteRequest,
  type SessionExecuteResponse,
  SessionNotFoundError,
  translateArkerError,
} from "./types.js";
