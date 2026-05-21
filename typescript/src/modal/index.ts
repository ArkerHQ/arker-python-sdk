/**
 * Drop-in compatibility shim for modal-js's Sandbox API, backed by Arker VMs.
 *
 *     import { Sandbox } from "@arker-ai/sdk/modal";
 *
 *     const sbx = await Sandbox.create();
 *     const p = await sbx.exec(["echo", "hello"]);
 *     console.log(await p.stdout.read());
 *     await sbx.terminate();
 *
 * Pending notes (mirrors `python/src/arker/modal/__init__.py`):
 *   - Most ctor kwargs (app, secrets, gpu, cloud, region, cpu, memory,
 *     volumes, etc.) are accepted but ignored.
 *   - App/Image/Secret/Volume/NetworkFileSystem are opaque placeholders.
 *   - Sandbox.fromName / tunnels / snapshotFilesystem / mountImage /
 *     createConnectToken / reloadVolumes / Sandbox.open / watch / stdin/out/err
 *     throw NotImplementedError.
 *   - ContainerProcess.stdin.write throws — no non-PTY stdin in Arker.
 *   - Stream readers are poll-based, not real-time.
 *   - exec(pty=true) throws (needs WS).
 */

export { Sandbox, type CreateOpts, type ExecOpts } from "./sandbox.js";
export { ContainerProcess, StreamReader, StreamWriter } from "./process.js";
export { SandboxFilesystem } from "./filesystem.js";
export {
  App,
  type FileInfo,
  FilesystemExecutionError,
  Image,
  NetworkFileSystem,
  NotFoundError,
  type SandboxConnectCredentials,
  SandboxError,
  SandboxTimeoutError,
  Secret,
  StreamType,
  type Tunnel,
  Volume,
  translateArkerError,
} from "./types.js";
