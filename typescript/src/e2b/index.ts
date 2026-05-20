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
 * See the Python `arker.e2b` package for the mirror surface and the
 * phased rollout plan. Real WS PTY streaming is a follow-up.
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
