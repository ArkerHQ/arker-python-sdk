/**
 * Drop-in compatibility shim for the e2b TypeScript SDK, backed by Arker VMs.
 *
 * Usage:
 *
 *     import { Sandbox } from "@arker-ai/sdk/e2b";
 *
 *     const sbx = await Sandbox.create();
 *     const r = await sbx.commands.run("echo hi");
 *     await sbx.files.write("/tmp/x.txt", "data");
 *     await sbx.kill();
 *
 * Pending work (each item also has a scoped `TODO(arker-e2b)` at the call
 * site; mirrors `python/src/arker/e2b/__init__.py`):
 *
 *   1. Server-side VM TTL — `timeout` only stored locally; warns via
 *      console.warn. VMs live until killed. See `sandbox.ts:warnTimeoutNoop`.
 *   2. ArkerError -> typed exception mapping. Subclasses exist
 *      (`TimeoutException`, `NotFoundException`, ...) but ArkerError still
 *      bubbles unchanged. See `types.ts` exception block.
 *   3. Live per-line `onStdout` / `onStderr` streaming — polls runStatus
 *      and emits per-poll deltas instead. Needs WS client. See `handle.ts`.
 *   4. Interactive PTY (`pty.create / sendStdin / resize / kill`) — same
 *      WS dependency. All throw today. See `pty.ts`.
 *   5. Jupyter-style stateful `runCode` — we shell out per call; state
 *      never persists, `Execution.results[]` always empty. See
 *      `code-interpreter/index.ts:runCode`.
 *   6. `commands.sendStdin` — no non-PTY stdin primitive in Arker. Throws.
 *   7. `files.read({ format: "stream" })` and `files.watchDir` — throw.
 *   8. `Sandbox.list()` metadata filter — Arker doesn't store metadata
 *      server-side; returns `{}` for every row.
 *   9. e2b-desktop (mouse/keyboard/screenshot) — out of scope.
 *  10. sandbox_id format (Arker ULIDs vs e2b `sb_xxx`) — cannot be fixed
 *      in this shim; document for users who regex-validate IDs.
 */

export { Sandbox, type SandboxOptions } from "./sandbox.js";
export { Commands, type RunOpts, wrapCommand } from "./commands.js";
export { Filesystem, WatchHandle, type ReadOptions } from "./files.js";
export { CommandHandle, type WaitOptions } from "./handle.js";
export { Pty } from "./pty.js";
export {
  AuthenticationException,
  CommandExitException,
  FileNotFoundException,
  FileType,
  InvalidArgumentException,
  NotEnoughSpaceException,
  NotFoundException,
  RateLimitException,
  SandboxException,
  SandboxNotFoundException,
  TemplateException,
  TimeoutException,
  type CommandResult,
  type EntryInfo,
  type ProcessInfo,
  type PtySize,
  type SandboxInfo,
} from "./types.js";
