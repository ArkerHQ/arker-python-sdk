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

export interface FileInfo {
  path: string;
  isDir: boolean;
  size: number;
  mode: number;
  mtime: number;
}

export interface Tunnel {
  host: string;
  port: number;
  unencryptedHost?: string | null;
  unencryptedPort?: number | null;
  /** Convenience: https://host:port */
  url: string;
  /** Convenience tuple. */
  tlsSocket: [string, number];
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

  aptInstall(..._packages: string[]): Image { return this; }
  pipInstall(..._packages: string[]): Image { return this; }
  runCommands(..._commands: string[]): Image { return this; }
  env(_envVars: Record<string, string>): Image { return this; }
  workdir(_path: string): Image { return this; }
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
