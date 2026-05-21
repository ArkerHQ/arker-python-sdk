/**
 * Drop-in compatibility shim for the @codesandbox/sdk SandboxAPI,
 * backed by Arker VMs.
 *
 *     import { CodeSandbox } from "@arker-ai/sdk/codesandbox";
 *
 *     const csb = new CodeSandbox("ark_live_...");
 *     const sandbox = await csb.sandboxes.create();
 *     const client = await sandbox.connect();
 *     const out = await client.commands.run("echo hello");
 *     await csb.sandboxes.delete(sandbox.id);
 *
 * Pending (see python/src/arker/codesandbox/__init__.py for full list):
 *   - sandboxes.hibernate/shutdown are no-op + console.warn
 *   - Sandbox.updateTier throws (Arker has no live VM-tier rescale)
 *   - SandboxClient.shells / tasks / ports / interpreters / hosts throw
 *     on any attribute access
 *   - list({tags}) throws (Arker doesn't store tags server-side)
 *   - fs.watch / download / batchWrite throw
 *   - commands.runBackground returns a Command but status isn't polled
 */

export { CodeSandbox, Sandboxes, type CreateSandboxOpts, type ListOpts } from "./client.js";
export { Sandbox } from "./sandbox.js";
export { SandboxClient } from "./sandbox-client.js";
export { Commands, type ShellRunOpts } from "./commands.js";
export { Filesystem } from "./filesystem.js";
export {
  AuthenticationError,
  type BootupType,
  CodeSandboxError,
  type Command,
  CommandError,
  type CommandStatus,
  type FSStatResult,
  type PaginationInfo,
  RateLimitError,
  type ReaddirEntry,
  type SandboxInfo,
  type SandboxListResponse,
  SandboxNotFoundError,
  VMTier,
  translateArkerError,
} from "./types.js";
