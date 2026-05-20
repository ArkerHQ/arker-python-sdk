/**
 * Drop-in compatibility shim for the daytona TypeScript SDK, backed by Arker VMs.
 *
 * Usage:
 *
 *     import { Daytona, type DaytonaConfig } from "@arker-ai/sdk/daytona";
 *
 *     const daytona = new Daytona({ apiKey: "ark_live_..." });
 *     const sbx = await daytona.create();
 *     const resp = await sbx.process.exec("echo hi");
 *     await sbx.delete();
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
 */

export { Daytona, type CreateOpts } from "./client.js";
export { Sandbox } from "./sandbox.js";
export { Process, type ExecOpts, wrapCommand } from "./process.js";
export { FileSystem } from "./files.js";
export {
  type Chart,
  type CodeRunParams,
  type Command,
  type DaytonaConfig,
  DaytonaError,
  type ExecuteResponse,
  type ExecutionArtifacts,
  type FileInfo,
  FileSystemError,
  type Match,
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
} from "./types.js";
