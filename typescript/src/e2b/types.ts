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
}

export interface ProcessInfo {
  pid: number;
  tag: string;
  cmd: string;
  cwd?: string;
}

export class SandboxException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxException";
  }
}

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
