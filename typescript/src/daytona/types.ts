/**
 * daytona-shaped types for the `@arker-ai/sdk/daytona` drop-in shim.
 *
 * Field naming matches daytona's TS SDK (`@daytonaio/sdk`). camelCase where
 * the JSON wire format is camelCase, snake_case_through (e.g. `cmd_id`,
 * `session_id`) where daytona's TS SDK exposes the wire shape directly.
 */

export enum SandboxState {
  Creating = "creating",
  Starting = "starting",
  Started = "started",
  Stopping = "stopping",
  Stopped = "stopped",
  Destroying = "destroying",
  Destroyed = "destroyed",
  Archiving = "archiving",
  Archived = "archived",
  Error = "error",
  BuildFailed = "build_failed",
  PendingBuild = "pending_build",
  BuildingSnapshot = "building_snapshot",
  PullingSnapshot = "pulling_snapshot",
  Resizing = "resizing",
  Snapshotting = "snapshotting",
  Forking = "forking",
  Restoring = "restoring",
  Unknown = "unknown",
}

export interface DaytonaConfig {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  jwtToken?: string;
  organizationId?: string;
  /** Deprecated alias for `apiUrl`. */
  serverUrl?: string;
}

export interface CreateSandboxFromSnapshotParams {
  snapshot?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  name?: string;
  volumes?: unknown[];
  networkBlockAll?: boolean;
  networkAllowList?: string;
  user?: string;
}

export interface CreateSandboxFromImageParams {
  image: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  name?: string;
  cpu?: number;
  gpu?: number;
  memory?: number;
  disk?: number;
  volumes?: unknown[];
  networkBlockAll?: boolean;
  networkAllowList?: string;
  user?: string;
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
  /** Daytona returns `[]` when no charts, not null. */
  charts: Chart[];
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
  /** Octal string ("755"), matching daytona's toolbox API. */
  mode: string;
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

/** daytona's SessionExecuteRequest. No `cwd`/`env` — caller inlines. */
export interface SessionExecuteRequest {
  command: string;
  /** Wire-format field. `runAsync` is the SDK alias accepted by daytona. */
  async?: boolean;
  runAsync?: boolean;
  /** Deprecated alias for `async`. */
  varAsync?: boolean;
}

export interface SessionExecuteResponse {
  cmdId: string;
  exitCode: number | null;
  output: string | null;
  stdout: string | null;
  stderr: string | null;
}

export interface Command {
  id: string;
  command: string;
  exitCode: number | null;
}

/** daytona's Session — only sessionId + commands. */
export interface Session {
  sessionId: string;
  commands: Command[];
}

/** daytona's SessionCommandLogsResponse — `output` is combined; no exitCode. */
export interface SessionCommandLogsResponse {
  output: string;
  stdout: string;
  stderr: string;
}

/** Wrapper returned by Daytona.list(). */
export class PaginatedSandboxes<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;

  constructor(items: T[], total: number, page: number, totalPages: number) {
    this.items = items;
    this.total = total;
    this.page = page;
    this.totalPages = totalPages;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (const item of this.items) yield item;
  }

  get length(): number {
    return this.items.length;
  }
}

// ---- Exception hierarchy ----

export class DaytonaError extends Error {
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly headers: Record<string, string>;

  constructor(message: string, opts: { statusCode?: number; errorCode?: string; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = "DaytonaError";
    this.statusCode = opts.statusCode;
    this.errorCode = opts.errorCode;
    this.headers = opts.headers ?? {};
  }
}

export class DaytonaNotFoundError extends DaytonaError {
  override name = "DaytonaNotFoundError";
}
export class DaytonaAuthenticationError extends DaytonaError {
  override name = "DaytonaAuthenticationError";
}
export class DaytonaAuthorizationError extends DaytonaError {
  override name = "DaytonaAuthorizationError";
}
export class DaytonaConflictError extends DaytonaError {
  override name = "DaytonaConflictError";
}
export class DaytonaRateLimitError extends DaytonaError {
  override name = "DaytonaRateLimitError";
}
export class DaytonaValidationError extends DaytonaError {
  override name = "DaytonaValidationError";
}
export class DaytonaTimeoutError extends DaytonaError {
  override name = "DaytonaTimeoutError";
}
export class DaytonaConnectionError extends DaytonaError {
  override name = "DaytonaConnectionError";
}
export class FileSystemError extends DaytonaError {
  override name = "FileSystemError";
}
export class ProcessError extends DaytonaError {
  override name = "ProcessError";
}

// Backward-compat aliases for shim-internal code; canonical names above.
export const SandboxNotFoundError = DaytonaNotFoundError;
export const SessionNotFoundError = DaytonaNotFoundError;

/** Map an `ArkerError` (or other low-level error) into the right
 *  daytona-typed exception by HTTP status code. Idempotent. */
export function translateArkerError(error: unknown): DaytonaError {
  if (error instanceof DaytonaError) return error;

  const status = (error as { status?: number }).status ?? 0;
  const code = (error as { code?: string }).code ?? "internal";
  const message = (error as { message?: string }).message ?? String(error);
  const opts = { statusCode: status, errorCode: code };

  if (status === 401) return new DaytonaAuthenticationError(message, opts);
  if (status === 403) return new DaytonaAuthorizationError(message, opts);
  if (status === 404) return new DaytonaNotFoundError(message, opts);
  if (status === 409) return new DaytonaConflictError(message, opts);
  if (status === 422 || status === 400) return new DaytonaValidationError(message, opts);
  if (status === 429) return new DaytonaRateLimitError(message, opts);
  if (status === 408 || status === 504) return new DaytonaTimeoutError(message, opts);
  if (status === 0) return new DaytonaConnectionError(message, opts);
  return new DaytonaError(message, opts);
}
