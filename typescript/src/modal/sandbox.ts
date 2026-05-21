import { Arker, ArkerError, type BackgroundRunResult, type Computer } from "../index.js";
import { SandboxFilesystem } from "./filesystem.js";
import { ContainerProcess } from "./process.js";
import {
  type Image,
  SandboxError,
  type StreamType,
  type Tunnel,
  translateArkerError,
} from "./types.js";

const DEFAULT_TEMPLATE_ENV = "ARKER_MODAL_DEFAULT_TEMPLATE";
const DEFAULT_TEMPLATE = "base";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveTemplate(image?: Image | string | null): string {
  if (image == null) {
    if (typeof process !== "undefined") return process.env[DEFAULT_TEMPLATE_ENV] ?? DEFAULT_TEMPLATE;
    return DEFAULT_TEMPLATE;
  }
  if (typeof image === "string") return image;
  const tag = (image as { _kwargs?: { tag?: unknown } })._kwargs?.tag;
  if (typeof tag === "string") return tag;
  if (typeof process !== "undefined") return process.env[DEFAULT_TEMPLATE_ENV] ?? DEFAULT_TEMPLATE;
  return DEFAULT_TEMPLATE;
}

export interface CreateOpts {
  app?: unknown;
  name?: string;
  tags?: Record<string, string>;
  image?: Image | string;
  env?: Record<string, string>;
  secrets?: unknown;
  networkFileSystems?: unknown;
  timeout?: number;
  idleTimeout?: number;
  workdir?: string;
  gpu?: unknown;
  cloud?: string;
  region?: string;
  cpu?: number;
  memory?: number;
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  inboundCidrAllowlist?: string[];
  volumes?: unknown;
  pty?: boolean;
  encryptedPorts?: number[];
  h2Ports?: number[];
  unencryptedPorts?: number[];
  customDomain?: string;
  proxy?: unknown;
  includeOidcIdentityToken?: boolean;
  readinessProbe?: unknown;
  verbose?: boolean;
  experimentalOptions?: Record<string, unknown>;
  client?: unknown;
  environmentName?: string;
  /** Test injection: pre-built Arker client. */
  _arker?: Arker;
}

export interface ExecOpts {
  stdout?: StreamType | number;
  stderr?: StreamType | number;
  timeout?: number;
  workdir?: string;
  env?: Record<string, string>;
  secrets?: unknown;
  text?: boolean;
  bufsize?: number;
  pty?: boolean;
}

export class Sandbox {
  readonly _arker: Arker;
  readonly _computer: Computer;
  private readonly _env: Record<string, string>;
  private _tags: Record<string, string>;
  private _returncode: number | null = null;

  readonly filesystem: SandboxFilesystem;

  constructor(arker: Arker, computer: Computer, opts: { env?: Record<string, string>; tags?: Record<string, string> } = {}) {
    this._arker = arker;
    this._computer = computer;
    this._env = { ...(opts.env ?? {}) };
    this._tags = { ...(opts.tags ?? {}) };
    this.filesystem = new SandboxFilesystem(this);
  }

  get objectId(): string {
    return this._computer.id;
  }

  get returncode(): number | null {
    return this._returncode;
  }

  static async create(opts: CreateOpts = {}): Promise<Sandbox> {
    if (opts.pty) {
      throw new Error("arker.modal: Sandbox.create(pty=true) is not supported yet.");
    }
    const arker = opts._arker ?? new Arker({});
    const source = resolveTemplate(opts.image);
    try {
      const computer = await arker.vm(source).fork(opts.name ? { name: opts.name } : {});
      return new Sandbox(arker, computer, { env: opts.env, tags: opts.tags });
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  static async fromId(sandboxId: string, opts: { _arker?: Arker } = {}): Promise<Sandbox> {
    if (!sandboxId) throw new SandboxError("sandboxId is required");
    const arker = opts._arker ?? new Arker({});
    return new Sandbox(arker, arker.vm(sandboxId));
  }

  static async fromName(_appName: string, _name: string, _opts: { environmentName?: string } = {}): Promise<Sandbox> {
    throw new Error(
      "arker.modal: Sandbox.fromName is not implemented — Arker has no App / named-sandbox concept.",
    );
  }

  static async list(_opts: { appId?: string; tags?: Record<string, string>; _arker?: Arker } = {}): Promise<Sandbox[]> {
    const arker = _opts._arker ?? new Arker({});
    try {
      const response = (await arker.list()) as { vms?: Array<{ vm_id?: string }> };
      return (response.vms ?? [])
        .filter((vm) => typeof vm.vm_id === "string")
        .map((vm) => new Sandbox(arker, arker.vm(vm.vm_id!)));
    } catch (error) {
      if (error instanceof ArkerError) return [];
      throw error;
    }
  }

  async exec(args: string[], opts: ExecOpts = {}): Promise<ContainerProcess> {
    if (opts.pty) {
      throw new Error("arker.modal: exec(pty=true) is not supported yet.");
    }
    if (args.length === 0) {
      throw new Error("exec() requires at least one argument");
    }
    let cmd = args.map(shellQuote).join(" ");
    const mergedEnv = { ...this._env, ...(opts.env ?? {}) };
    if (Object.keys(mergedEnv).length > 0) {
      const envParts = Object.entries(mergedEnv).map(([k, v]) => `${shellQuote(k)}=${shellQuote(v)}`).join(" ");
      cmd = `env ${envParts} ${cmd}`;
    }
    if (opts.workdir) {
      cmd = `cd ${shellQuote(opts.workdir)} && ${cmd}`;
    }

    let result;
    try {
      result = (await this._computer.run(cmd, { background: true, timeout: opts.timeout })) as BackgroundRunResult;
    } catch (error) {
      throw translateArkerError(error);
    }
    if (result.type !== "background") {
      throw new SandboxError(`exec expected BackgroundRunResult, got ${result.type}`);
    }
    return new ContainerProcess(this, result.runId, opts.text ?? true);
  }

  async terminate(_wait: boolean = false): Promise<number | null> {
    try {
      await this._computer.delete();
    } catch (error) {
      throw translateArkerError(error);
    }
    if (this._returncode === null) this._returncode = 0;
    return this._returncode;
  }

  async wait(_raiseOnTermination: boolean = true): Promise<void> {
    // No-op: Arker VMs don't auto-terminate based on an entrypoint.
  }

  poll(): number | null {
    return this._returncode;
  }

  hydrate(_client?: unknown): Sandbox {
    return this;
  }

  detach(): void {
    // No-op: we hold no connection state.
  }

  async waitUntilReady(_timeout: number = 300): Promise<void> {
    // Arker VMs are ready when fork() returns.
  }

  // ---- Tags ----

  getTags(): Record<string, string> {
    return { ...this._tags };
  }

  setTags(tags: Record<string, string>): void {
    this._tags = { ...tags };
  }

  // ---- Tunnels / unsupported ----

  async tunnels(_timeout: number = 50): Promise<Record<number, Tunnel>> {
    throw new Error(
      "arker.modal: Sandbox.tunnels() is not implemented — Arker exposes tunnels via run(network=...) " +
        "but we don't bind them to the Sandbox lifetime.",
    );
  }

  async snapshotFilesystem(_timeout: number = 55): Promise<unknown> {
    throw new Error("arker.modal: Sandbox.snapshotFilesystem is not supported.");
  }

  async snapshotDirectory(_path: string): Promise<unknown> {
    throw new Error("arker.modal: Sandbox.snapshotDirectory is not supported.");
  }

  async mountImage(_path: string, _image: unknown): Promise<void> {
    throw new Error("arker.modal: Sandbox.mountImage is not supported.");
  }

  async unmountImage(_path: string): Promise<void> {
    throw new Error("arker.modal: Sandbox.unmountImage is not supported.");
  }

  async createConnectToken(_userMetadata?: unknown): Promise<unknown> {
    throw new Error("arker.modal: Sandbox.createConnectToken is not supported.");
  }

  async reloadVolumes(): Promise<void> {
    throw new Error("arker.modal: Sandbox.reloadVolumes is not supported.");
  }

  open(_path: string, _mode: string = "r"): unknown {
    throw new Error(
      "arker.modal: Sandbox.open is deprecated upstream — use sbx.filesystem.readText / writeText.",
    );
  }

  watch(..._args: unknown[]): never {
    throw new Error("arker.modal: Sandbox.watch is not supported — no fs-event API.");
  }

  get stdout(): never {
    throw new Error(
      "arker.modal: Sandbox.stdout is not supported — modal's Sandbox streams correspond to the " +
        "entrypoint command; use the ContainerProcess returned by sbx.exec() instead.",
    );
  }

  get stderr(): never {
    throw new Error("arker.modal: Sandbox.stderr is not supported. Use sbx.exec().");
  }

  get stdin(): never {
    throw new Error("arker.modal: Sandbox.stdin is not supported. Use sbx.exec().");
  }
}
