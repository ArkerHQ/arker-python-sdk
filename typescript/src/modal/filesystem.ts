import { promises as fs } from "node:fs";

import type { CompletedRunResult } from "../index.js";
import type { Sandbox } from "./sandbox.js";
import {
  FileInfo,
  FileType,
  FilesystemExecutionError,
  InvalidError,
  NotFoundError,
  translateArkerError,
} from "./types.js";

// Modal's FileInfo: name, path, type, size, mode, permissions, owner, group,
// modifiedTime, symlinkTarget. Find format: kind|size|mode|UID|GID|mtime|symlink.
const FIND_FMT = "%y|%s|%m|%U|%G|%T@|%l\\n";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

function kindToFileType(kind: string): FileType {
  if (kind === "d") return FileType.Directory;
  if (kind === "f") return FileType.File;
  if (kind === "l") return FileType.Symlink;
  return FileType.Unknown;
}

function parseFindLine(line: string, remotePath: string): FileInfo | null {
  const parts = line.split("|");
  if (parts.length < 6) return null;
  const [kind, sizeStr, modeStr, owner, group, mtimeStr, symlinkRaw] = parts;
  const size = Number(sizeStr) || 0;
  const mode = parseInt(modeStr ?? "", 8) || 0;
  const mtime = Number(mtimeStr) || 0;
  return new FileInfo({
    name: basename(remotePath) || remotePath,
    path: remotePath,
    type: kindToFileType(kind ?? ""),
    size,
    mode,
    permissions: (modeStr ?? "").padStart(4, "0"),
    owner: owner ?? "",
    group: group ?? "",
    modifiedTime: mtime,
    symlinkTarget: symlinkRaw ? symlinkRaw : null,
  });
}

function validateAbsolute(path: string, op: string): void {
  if (typeof path !== "string" || !path) {
    throw new InvalidError(`${op}: path must be a non-empty string`);
  }
  if (!path.startsWith("/")) {
    throw new InvalidError(`${op}: path must be absolute (got ${path})`);
  }
}

export class SandboxFilesystem {
  private readonly sbx: Sandbox;

  constructor(sbx: Sandbox) {
    this.sbx = sbx;
  }

  // ---- Native (Arker sync API) ----

  async readBytes(remotePath: string): Promise<Uint8Array> {
    validateAbsolute(remotePath, "readBytes");
    try {
      return await this.sbx._computer.sync.readFile(remotePath);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async readText(remotePath: string): Promise<string> {
    return decode(await this.readBytes(remotePath));
  }

  async writeBytes(data: Uint8Array, remotePath: string): Promise<void> {
    validateAbsolute(remotePath, "writeBytes");
    try {
      await this.sbx._computer.sync.writeFile(remotePath, data);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async writeText(data: string, remotePath: string): Promise<void> {
    validateAbsolute(remotePath, "writeText");
    try {
      await this.sbx._computer.sync.writeFile(remotePath, data);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  async copyFromLocal(localPath: string, remotePath: string): Promise<void> {
    validateAbsolute(remotePath, "copyFromLocal");
    const data = await fs.readFile(localPath);
    await this.writeBytes(new Uint8Array(data), remotePath);
  }

  async copyToLocal(remotePath: string, localPath: string): Promise<void> {
    validateAbsolute(remotePath, "copyToLocal");
    const data = await this.readBytes(remotePath);
    await fs.writeFile(localPath, data);
  }

  // ---- Shell-shim ----

  async listFiles(remotePath: string): Promise<FileInfo[]> {
    validateAbsolute(remotePath, "listFiles");
    const { stdout, stderr, exitCode } = await this.shell(
      `find ${shellQuote(remotePath)} -maxdepth 1 -mindepth 1 -printf ${shellQuote("%p|" + FIND_FMT)}`,
    );
    if (exitCode !== 0) {
      if (stderr.includes("No such") || stderr.toLowerCase().includes("cannot access")) {
        throw new NotFoundError(`path ${remotePath} not found`);
      }
      throw new FilesystemExecutionError(`listFiles(${remotePath}) failed: ${stderr.trim()}`);
    }
    const entries: FileInfo[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const firstPipe = line.indexOf("|");
      if (firstPipe < 0) continue;
      const path = line.slice(0, firstPipe);
      const parsed = parseFindLine(line.slice(firstPipe + 1), path);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  async makeDirectory(remotePath: string, opts: { createParents?: boolean } = {}): Promise<void> {
    validateAbsolute(remotePath, "makeDirectory");
    const flag = opts.createParents !== false ? "-p" : "";
    const { stderr, exitCode } = await this.shell(`mkdir ${flag} ${shellQuote(remotePath)}`.trim());
    if (exitCode !== 0) {
      throw new FilesystemExecutionError(`makeDirectory(${remotePath}) failed: ${stderr.trim()}`);
    }
  }

  async remove(remotePath: string, opts: { recursive?: boolean } = {}): Promise<void> {
    validateAbsolute(remotePath, "remove");
    const flag = opts.recursive ? "-rf" : "-f";
    const { stderr, exitCode } = await this.shell(`rm ${flag} ${shellQuote(remotePath)}`);
    if (exitCode !== 0) {
      throw new FilesystemExecutionError(`remove(${remotePath}) failed: ${stderr.trim()}`);
    }
  }

  async stat(remotePath: string): Promise<FileInfo> {
    validateAbsolute(remotePath, "stat");
    const { stdout, stderr, exitCode } = await this.shell(
      `find ${shellQuote(remotePath)} -maxdepth 0 -printf ${shellQuote(FIND_FMT)}`,
    );
    if (exitCode !== 0 || !stdout.trim()) {
      if (stderr.includes("No such") || stderr.toLowerCase().includes("cannot access")) {
        throw new NotFoundError(`path ${remotePath} not found`);
      }
      throw new FilesystemExecutionError(`stat(${remotePath}) failed: ${stderr.trim() || "not found"}`);
    }
    const parsed = parseFindLine(stdout.split("\n")[0]!, remotePath);
    if (!parsed) throw new FilesystemExecutionError(`stat(${remotePath}): unparseable`);
    return parsed;
  }

  watch(..._args: unknown[]): never {
    throw new Error("arker.modal: filesystem.watch is not supported — no fs-event API.");
  }

  // ---- Internals ----

  private async shell(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let result;
    try {
      result = (await this.sbx._computer.run(cmd)) as CompletedRunResult;
    } catch (error) {
      throw translateArkerError(error);
    }
    if (result.type !== "completed") {
      throw new FilesystemExecutionError(`unexpected run result type ${result.type}`);
    }
    return {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      exitCode: result.exitCode,
    };
  }
}
