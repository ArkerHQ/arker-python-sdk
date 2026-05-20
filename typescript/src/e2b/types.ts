/**
 * e2b-shaped types for the `@arker-ai/sdk/e2b` drop-in shim.
 *
 * These mirror the public types exposed by `e2b` so user code that
 * destructures the result keeps working unchanged.
 */

export enum FileType {
  File = "file",
  Dir = "dir",
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string | null;
}

export interface EntryInfo {
  name: string;
  type: FileType;
  path: string;
  size?: number;
  mode?: number;
  permissions?: string;
  owner?: string;
  group?: string;
  modifiedTime?: Date;
  symlinkTarget?: string | null;
}

export interface ProcessInfo {
  pid: number;
  tag: string;
  cmd: string;
  args?: string[];
  envs?: Record<string, string>;
  cwd?: string;
}

export interface SandboxInfo {
  sandboxId: string;
  templateId: string | null;
  name: string | null;
  metadata: Record<string, string>;
  startedAt: Date;
  endAt: Date | null;
}

export class SandboxException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxException";
  }
}

// e2b's typed-exception hierarchy. Empty subclasses so existing
// `catch (e) { if (e instanceof TimeoutException) ... }` patterns work.
//
// TODO(arker-e2b): translate ArkerError -> the right subclass at the
// boundary. Discriminator: ArkerError.status (HTTP) + ArkerError.code
// ("not_found", "unauthorized", "rate_limit", ...). Wrap _arker calls
// in the Sandbox shim and translate before re-raising. See pending-work
// item #2 in index.ts.
export class TimeoutException extends SandboxException { override name = "TimeoutException" }
export class InvalidArgumentException extends SandboxException { override name = "InvalidArgumentException" }
export class NotEnoughSpaceException extends SandboxException { override name = "NotEnoughSpaceException" }
export class NotFoundException extends SandboxException { override name = "NotFoundException" }
export class FileNotFoundException extends NotFoundException { override name = "FileNotFoundException" }
export class SandboxNotFoundException extends NotFoundException { override name = "SandboxNotFoundException" }
export class AuthenticationException extends SandboxException { override name = "AuthenticationException" }
export class RateLimitException extends SandboxException { override name = "RateLimitException" }
export class TemplateException extends SandboxException { override name = "TemplateException" }

export class CommandExitException extends SandboxException {
  readonly result: CommandResult;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(result: CommandResult) {
    const tail = (result.stderr || result.stdout || "").slice(0, 200);
    super(`command exited with code ${result.exitCode}: ${tail}`);
    this.name = "CommandExitException";
    this.result = result;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export interface PtySize {
  rows: number;
  cols: number;
}
