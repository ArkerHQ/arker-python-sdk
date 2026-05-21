import type { CompletedRunResult } from "../index.js";
import type { SandboxClient } from "./sandbox-client.js";
import {
  CodeSandboxError,
  type FSStatResult,
  type ReaddirEntry,
  translateArkerError,
} from "./types.js";

const STAT_FMT = "%y|%s|%T@|%A@|%C@\\n";
const READDIR_FMT = "%f|%y\\n";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function kindToType(kind: string): "file" | "directory" | "symlink" {
  if (kind === "d") return "directory";
  if (kind === "l") return "symlink";
  return "file";
}

/** Mirrors `@codesandbox/sdk` SandboxClient.fs. */
export class Filesystem {
  private readonly client: SandboxClient;

  constructor(client: SandboxClient) {
    this.client = client;
  }

  // ---- Native (Arker sync API) ----

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return await this.client._sandbox._computer.sync.readFile(path);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async readTextFile(path: string): Promise<string> {
    return decode(await this.readFile(path));
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    try {
      await this.client._sandbox._computer.sync.writeFile(path, content);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async writeTextFile(path: string, content: string, _opts: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.client._sandbox._computer.sync.writeFile(path, content);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  // ---- Shell-shim ----

  async readdir(path: string): Promise<ReaddirEntry[]> {
    const { stdout, exitCode } = await this.shell(
      `find ${shellQuote(path)} -maxdepth 1 -mindepth 1 -printf ${shellQuote(READDIR_FMT)}`,
    );
    if (exitCode !== 0) throw new CodeSandboxError(`readdir(${path}) failed`);
    const entries: ReaddirEntry[] = [];
    for (const line of stdout.split("\n")) {
      if (!line || !line.includes("|")) continue;
      const lastPipe = line.lastIndexOf("|");
      const name = line.slice(0, lastPipe);
      const kind = line.slice(lastPipe + 1);
      entries.push({ name, type: kindToType(kind), isSymlink: kind === "l" });
    }
    return entries;
  }

  async stat(path: string): Promise<FSStatResult> {
    const { stdout, exitCode } = await this.shell(
      `find ${shellQuote(path)} -maxdepth 0 -printf ${shellQuote(STAT_FMT)}`,
    );
    if (exitCode !== 0 || !stdout.trim()) {
      throw new CodeSandboxError(`stat(${path}) failed: not found`);
    }
    const parts = stdout.split("\n")[0]!.split("|");
    if (parts.length < 5) throw new CodeSandboxError(`stat(${path}): unparseable`);
    const [kind, sizeStr, mtimeStr, atimeStr, ctimeStr] = parts;
    return {
      type: kindToType(kind ?? ""),
      size: Number(sizeStr) || 0,
      atime: Number(atimeStr) || 0,
      mtime: Number(mtimeStr) || 0,
      ctime: Number(ctimeStr) || 0,
    };
  }

  async mkdir(path: string, recursive: boolean = false): Promise<void> {
    const flag = recursive ? "-p" : "";
    const { stderr, exitCode } = await this.shell(`mkdir ${flag} ${shellQuote(path)}`.trim());
    if (exitCode !== 0) throw new CodeSandboxError(`mkdir(${path}) failed: ${stderr.trim()}`);
  }

  async remove(path: string, recursive: boolean = false): Promise<void> {
    const flag = recursive ? "-rf" : "-f";
    const { stderr, exitCode } = await this.shell(`rm ${flag} ${shellQuote(path)}`);
    if (exitCode !== 0) throw new CodeSandboxError(`remove(${path}) failed: ${stderr.trim()}`);
  }

  async rename(from: string, to: string, _overwrite: boolean = false): Promise<void> {
    const { stderr, exitCode } = await this.shell(`mv ${shellQuote(from)} ${shellQuote(to)}`);
    if (exitCode !== 0) throw new CodeSandboxError(`rename failed: ${stderr.trim()}`);
  }

  async copy(from: string, to: string, recursive: boolean = false): Promise<void> {
    const flag = recursive ? "-r" : "";
    const { stderr, exitCode } = await this.shell(
      `cp ${flag} ${shellQuote(from)} ${shellQuote(to)}`.trim(),
    );
    if (exitCode !== 0) throw new CodeSandboxError(`copy failed: ${stderr.trim()}`);
  }

  // ---- Not implemented ----

  watch(..._args: unknown[]): never {
    throw new Error("arker.codesandbox: fs.watch is not supported — no fs-event API.");
  }

  download(_path: string): never {
    throw new Error("arker.codesandbox: fs.download is not supported.");
  }

  batchWrite(..._args: unknown[]): never {
    throw new Error("arker.codesandbox: fs.batchWrite is not supported — loop over fs.writeFile.");
  }

  // ---- Internals ----

  private async shell(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let result;
    try {
      result = (await this.client._sandbox._computer.run(cmd)) as CompletedRunResult;
    } catch (error) {
      throw translateArkerError(error);
    }
    if (result.type !== "completed") {
      throw new CodeSandboxError(`unexpected run result type ${result.type}`);
    }
    return {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      exitCode: result.exitCode,
    };
  }
}
