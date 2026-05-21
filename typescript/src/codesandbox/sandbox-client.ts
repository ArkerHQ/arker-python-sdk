import { Commands } from "./commands.js";
import { Filesystem } from "./filesystem.js";
import type { Sandbox } from "./sandbox.js";

function makeStub(name: string, reason: string): Record<string, unknown> {
  return new Proxy({}, {
    get(_target, prop) {
      throw new Error(
        `arker.codesandbox: SandboxClient.${name}.${String(prop)} is not supported — ${reason}`,
      );
    },
  });
}

/** Mirrors `@codesandbox/sdk` SandboxClient. Returned by `Sandbox.connect()`. */
export class SandboxClient {
  readonly _sandbox: Sandbox;
  readonly commands: Commands;
  readonly fs: Filesystem;
  readonly shells: Record<string, unknown>;
  readonly tasks: Record<string, unknown>;
  readonly ports: Record<string, unknown>;
  readonly interpreters: Record<string, unknown>;
  readonly hosts: Record<string, unknown>;

  constructor(sandbox: Sandbox) {
    this._sandbox = sandbox;
    this.commands = new Commands(this);
    this.fs = new Filesystem(this);
    this.shells = makeStub("shells", "interactive shells need a WS client");
    this.tasks = makeStub("tasks", "tasks are codesandbox-specific project metadata");
    this.ports = makeStub("ports", "port previews need persistent tunnels bound to sandbox lifetime");
    this.interpreters = makeStub("interpreters", "stateful interpreters need a long-running kernel");
    this.hosts = makeStub("hosts", "host tokens are codesandbox auth-server primitives");
  }

  disconnect(): void {
    /* no-op — we hold no persistent connection */
  }
}
