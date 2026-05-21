/**
 * codesandbox-shaped types for the `@arker-ai/sdk/codesandbox` shim.
 * Field naming mirrors `@codesandbox/sdk`.
 */

export type BootupType = "RUNNING" | "RESUME" | "CLEAN" | "FORK";

export type CommandStatus = "RUNNING" | "FINISHED" | "ERROR" | "KILLED" | "RESTARTING";

export interface SandboxInfo {
  id: string;
  title?: string | null;
  description?: string | null;
  tags: string[];
  privacy: string;
  /** Matches `@codesandbox/sdk`: real `Date` instances, not raw strings. */
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface PaginationInfo {
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
}

export interface SandboxListResponse {
  sandboxes: SandboxInfo[];
  totalCount: number;
  /** Matches codesandbox: pagination is always present (not optional). */
  pagination: PaginationInfo;
  /** Matches codesandbox: `hasMore` is the canonical "more pages?" flag. */
  hasMore: boolean;
}

export interface ReaddirEntry {
  name: string;
  /** Matches codesandbox: only "file" / "directory". Symlinks carry
   * `isSymlink: true` and `type` set to the resolved kind. */
  type: "file" | "directory";
  isSymlink: boolean;
}

export interface FSStatResult {
  type: "file" | "directory";
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
  /** Matches codesandbox: symlinks are flagged separately from `type`. */
  isSymlink: boolean;
}

export interface Command {
  name: string;
  status: CommandStatus;
  output: string;
  exitCode: number | null;
  /** @internal — used by the shim to poll status. */
  _runId?: string;
}

// ---- Exceptions ----

export class CodeSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeSandboxError";
  }
}

export class CommandError extends CodeSandboxError {
  readonly exitCode: number;
  readonly output: string;
  constructor(message: string, exitCode: number, output: string) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
    this.output = output;
  }
}

export class SandboxNotFoundError extends CodeSandboxError {
  override name = "SandboxNotFoundError";
}

export class AuthenticationError extends CodeSandboxError {
  override name = "AuthenticationError";
}

export class RateLimitError extends CodeSandboxError {
  override name = "RateLimitError";
}

export function translateArkerError(error: unknown): CodeSandboxError {
  if (error instanceof CodeSandboxError) return error;
  const status = (error as { status?: number }).status ?? 0;
  const message = (error as { message?: string }).message ?? String(error);
  if (status === 404) return new SandboxNotFoundError(message);
  if (status === 401) return new AuthenticationError(message);
  if (status === 429) return new RateLimitError(message);
  return new CodeSandboxError(message);
}

// ---- VMTier (opaque) ----

export class VMTier {
  readonly name: string;
  readonly cpu?: number;
  readonly memoryGib?: number;

  constructor(name: string, cpu?: number, memoryGib?: number) {
    this.name = name;
    this.cpu = cpu;
    this.memoryGib = memoryGib;
  }

  static readonly Pico = new VMTier("Pico", 1, 1);
  static readonly Nano = new VMTier("Nano", 2, 4);
  static readonly Micro = new VMTier("Micro", 4, 8);
  static readonly Small = new VMTier("Small", 8, 16);
  static readonly Medium = new VMTier("Medium", 16, 32);
  static readonly Large = new VMTier("Large", 32, 64);
  static readonly XLarge = new VMTier("XLarge", 64, 128);
}
