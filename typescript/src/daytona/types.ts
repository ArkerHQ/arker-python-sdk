/**
 * daytona-shaped types for the `@arker-ai/sdk/daytona` drop-in shim.
 *
 * Mirrors the public types exposed by `@daytonaio/sdk`. Field naming is
 * daytona-canonical (camelCase) — e.g. `cmdId`, `exitCode`, `isDir`.
 */

export enum SandboxState {
  Creating = "creating",
  Started = "started",
  Stopped = "stopped",
  Deleting = "deleting",
  Error = "error",
  Archived = "archived",
}

export interface DaytonaConfig {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

export interface CodeRunParams {
  argv?: string[];
  env?: Record<string, string>;
}

export interface Chart {
  type?: string;
  title?: string | null;
}

export interface ExecutionArtifacts {
  stdout: string;
  charts?: Chart[] | null;
}

export interface ExecuteResponse {
  exitCode: number;
  result: string;
  artifacts?: ExecutionArtifacts;
}

export interface FileInfo {
  name: string;
  isDir: boolean;
  size: number;
  mode: number;
  owner: string;
  group: string;
  modTime: string;
  permissions: string;
}

export interface Match {
  file: string;
  line: number;
  content: string;
}

export interface SearchFilesResponse {
  files: string[];
}

export interface ReplaceResult {
  file: string;
  success: boolean;
  error?: string | null;
}

export interface SessionExecuteRequest {
  command: string;
  /** Run as a background command. daytona names this `async` but
   * `async` is a reserved word in JS class params; daytona's TS SDK
   * uses `async: boolean` on plain object literals which is fine.
   * We accept both `async` and `runAsync` for compatibility. */
  async?: boolean;
  runAsync?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SessionExecuteResponse {
  cmdId: string;
  output: string | null;
  exitCode: number | null;
}

export interface Command {
  id: string;
  command: string;
  exitCode: number | null;
}

export interface Session {
  sessionId: string;
  state: string;
  cwd: string;
  commands: Command[];
}

export interface SessionCommandLogsResponse {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// ---- Errors ----

export class DaytonaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaError";
  }
}

export class FileSystemError extends DaytonaError {
  override name = "FileSystemError";
}

export class ProcessError extends DaytonaError {
  override name = "ProcessError";
}

export class SandboxNotFoundError extends DaytonaError {
  override name = "SandboxNotFoundError";
}

export class SessionNotFoundError extends DaytonaError {
  override name = "SessionNotFoundError";
}
