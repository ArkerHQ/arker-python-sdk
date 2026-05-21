/**
 * modal-shaped types for the `@arker-ai/sdk/modal` drop-in shim.
 *
 * Field naming mirrors `modal-js`. Numeric `mode`, lowercase enum values.
 */

export enum StreamType {
  Pipe = "pipe",
  Stdout = "stdout",
  Stderr = "stderr",
  Devnull = "devnull",
}

export enum FileType {
  File = "file",
  Directory = "directory",
  Symlink = "symlink",
}

/** Mirrors `modal.FileInfo`. `isDir()` / `isFile()` / `isSymlink()` are methods,
 * not boolean fields — modal's source uses methods, and customer code expecting
 * `info.isDir()` would `TypeError` against a boolean field. */
export class FileInfo {
  readonly name: string;
  readonly path: string;
  readonly type: FileType;
  readonly size: number;
  readonly mode: number;
  readonly permissions: string;
  readonly owner: string;
  readonly group: string;
  readonly modifiedTime: number;
  readonly symlinkTarget: string | null;

  constructor(init: {
    name: string;
    path: string;
    type: FileType;
    size?: number;
    mode?: number;
    permissions?: string;
    owner?: string;
    group?: string;
    modifiedTime?: number;
    symlinkTarget?: string | null;
  }) {
    this.name = init.name;
    this.path = init.path;
    this.type = init.type;
    this.size = init.size ?? 0;
    this.mode = init.mode ?? 0;
    this.permissions = init.permissions ?? "";
    this.owner = init.owner ?? "";
    this.group = init.group ?? "";
    this.modifiedTime = init.modifiedTime ?? 0;
    this.symlinkTarget = init.symlinkTarget ?? null;
  }

  isFile(): boolean { return this.type === FileType.File; }
  isDir(): boolean { return this.type === FileType.Directory; }
  isSymlink(): boolean { return this.type === FileType.Symlink; }
}

/** Matches `modal.Tunnel`. `.url` omits `:443` (the implicit HTTPS port). */
export class Tunnel {
  readonly host: string;
  readonly port: number;
  readonly unencryptedHost: string | null;
  readonly unencryptedPort: number | null;

  constructor(init: { host: string; port: number; unencryptedHost?: string | null; unencryptedPort?: number | null }) {
    this.host = init.host;
    this.port = init.port;
    this.unencryptedHost = init.unencryptedHost ?? null;
    this.unencryptedPort = init.unencryptedPort ?? null;
  }

  get url(): string {
    return this.port === 443 ? `https://${this.host}` : `https://${this.host}:${this.port}`;
  }

  get tlsSocket(): [string, number] {
    return [this.host, this.port];
  }
}

export interface SandboxConnectCredentials {
  url: string;
  token: string;
}

// ---- Exceptions ----

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export class SandboxTimeoutError extends SandboxError {
  override name = "SandboxTimeoutError";
}

export class NotFoundError extends SandboxError {
  override name = "NotFoundError";
}

export class FilesystemExecutionError extends SandboxError {
  override name = "FilesystemExecutionError";
}

/** Mirrors modal.exception.InvalidError. */
export class InvalidError extends SandboxError {
  override name = "InvalidError";
}

// Granular filesystem exceptions — modal raises these specifically.
export class SandboxFilesystemNotFoundError extends FilesystemExecutionError {
  override name = "SandboxFilesystemNotFoundError";
}
export class SandboxFilesystemPermissionError extends FilesystemExecutionError {
  override name = "SandboxFilesystemPermissionError";
}
export class SandboxFilesystemIsADirectoryError extends FilesystemExecutionError {
  override name = "SandboxFilesystemIsADirectoryError";
}
export class SandboxFilesystemNotADirectoryError extends FilesystemExecutionError {
  override name = "SandboxFilesystemNotADirectoryError";
}
export class SandboxFilesystemDirectoryNotEmptyError extends FilesystemExecutionError {
  override name = "SandboxFilesystemDirectoryNotEmptyError";
}
export class SandboxFilesystemPathAlreadyExistsError extends FilesystemExecutionError {
  override name = "SandboxFilesystemPathAlreadyExistsError";
}
export class SandboxFilesystemFileTooLargeError extends FilesystemExecutionError {
  override name = "SandboxFilesystemFileTooLargeError";
}

/** Map a shell stderr string to the right SandboxFilesystem* subclass. */
export function classifyFsError(stderr: string, defaultMessage: string = ""): FilesystemExecutionError {
  const s = stderr || defaultMessage;
  const msg = s.trim() || defaultMessage || "filesystem error";
  const sl = s.toLowerCase();
  if (sl.includes("no such") || sl.includes("cannot access")) return new SandboxFilesystemNotFoundError(msg);
  if (sl.includes("permission denied")) return new SandboxFilesystemPermissionError(msg);
  if (sl.includes("is a directory")) return new SandboxFilesystemIsADirectoryError(msg);
  if (sl.includes("not a directory")) return new SandboxFilesystemNotADirectoryError(msg);
  if (sl.includes("directory not empty")) return new SandboxFilesystemDirectoryNotEmptyError(msg);
  if (sl.includes("file exists") || sl.includes("already exists")) return new SandboxFilesystemPathAlreadyExistsError(msg);
  if (sl.includes("file too large") || sl.includes("no space")) return new SandboxFilesystemFileTooLargeError(msg);
  return new FilesystemExecutionError(msg);
}

export function translateArkerError(error: unknown): SandboxError {
  if (error instanceof SandboxError) return error;
  const status = (error as { status?: number }).status ?? 0;
  const message = (error as { message?: string }).message ?? String(error);
  if (status === 404) return new NotFoundError(message);
  if (status === 408 || status === 504) return new SandboxTimeoutError(message);
  return new SandboxError(message);
}

// ---- Opaque modal placeholders ----

class ModalOpaque {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly _kwargs: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(kwargs: Record<string, any> = {}) {
    this._kwargs = kwargs;
  }
}

export class App extends ModalOpaque {}

export class Image extends ModalOpaque {
  static debianSlim(pythonVersion?: string): Image {
    return new Image({ _recipe: "debian_slim", pythonVersion });
  }

  static fromRegistry(tag: string, opts: Record<string, unknown> = {}): Image {
    return new Image({ _recipe: "from_registry", tag, ...opts });
  }

  static fromDockerfile(path: string, opts: Record<string, unknown> = {}): Image {
    return new Image({ _recipe: "from_dockerfile", path, ...opts });
  }

  // Each builder returns a NEW Image — matches modal's immutability.
  private spawn(extra: Record<string, unknown>): Image {
    return new Image({ ...this._kwargs, _base: this, ...extra });
  }

  aptInstall(...packages: string[]): Image { return this.spawn({ _op: "apt_install", packages }); }
  pipInstall(...packages: string[]): Image { return this.spawn({ _op: "pip_install", packages }); }
  runCommands(...commands: string[]): Image { return this.spawn({ _op: "run_commands", commands }); }
  env(envVars: Record<string, string>): Image { return this.spawn({ _op: "env", envVars }); }
  workdir(path: string): Image { return this.spawn({ _op: "workdir", path }); }
}

export class Secret extends ModalOpaque {
  static fromDict(envDict: Record<string, string>): Secret {
    return new Secret({ _recipe: "from_dict", env: envDict });
  }

  static fromName(name: string): Secret {
    return new Secret({ _recipe: "from_name", name });
  }
}

export class Volume extends ModalOpaque {
  static fromName(name: string): Volume {
    return new Volume({ _recipe: "from_name", name });
  }
}

export class NetworkFileSystem extends ModalOpaque {
  static fromName(name: string): NetworkFileSystem {
    return new NetworkFileSystem({ _recipe: "from_name", name });
  }
}
