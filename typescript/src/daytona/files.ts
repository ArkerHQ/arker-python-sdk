import type { CompletedRunResult } from "../index.js";
import type { Sandbox } from "./sandbox.js";
import {
  DaytonaNotFoundError,
  type FileInfo,
  FileSystemError,
  type Match,
  type ReplaceResult,
  type SearchFilesResponse,
  translateArkerError,
} from "./types.js";

// Match daytona's daemon shape: mode = Go FileMode string ("-rw-r--r--"),
// permissions = "0644" 4-digit octal, owner/group = numeric UID/GID,
// mod_time = formatted timestamp.
const FIND_FMT = "%f|%y|%s|%M|%m|%U|%G|%TY-%Tm-%Td %TH:%TM:%TS\\n";

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

function parseFindLine(line: string): FileInfo | null {
  const parts = line.split("|");
  if (parts.length < 8) return null;
  const [name, kind, sizeStr, modeStr, permStr, owner, group, mtimeStr] = parts;
  const size = Number(sizeStr) || 0;
  const perms = (permStr ?? "").padStart(4, "0");
  return {
    name: name ?? "",
    isDir: kind === "d",
    size,
    mode: modeStr ?? "",          // Go-FileMode form ("-rw-r--r--")
    owner: owner ?? "",           // numeric UID
    group: group ?? "",           // numeric GID
    modTime: mtimeStr ?? "",      // "YYYY-MM-DD HH:MM:SS"
    permissions: perms,           // 4-digit octal
  };
}

type FileSource = Uint8Array | string;

export class FileSystem {
  private readonly sbx: Sandbox;

  constructor(sbx: Sandbox) {
    this.sbx = sbx;
  }

  // ---- Native (Arker sync API) ----

  async uploadFile(file: FileSource, remotePath: string): Promise<void> {
    try {
      if (file instanceof Uint8Array) {
        await this.sbx._computer.sync.writeFile(remotePath, file);
        return;
      }
      if (typeof file === "string") {
        await this.sbx._computer.sync.writeFile(remotePath, file);
        return;
      }
    } catch (error) {
      throw translateArkerError(error);
    }
    throw new FileSystemError(`unsupported file argument type`);
  }

  async downloadFile(remotePath: string): Promise<Uint8Array> {
    try {
      return await this.sbx._computer.sync.readFile(remotePath);
    } catch (error) {
      throw translateArkerError(error);
    }
  }

  // ---- Shell-shim ----

  async listFiles(path: string): Promise<FileInfo[]> {
    const { stdout, stderr, exitCode } = await this.shell(
      `find ${shellQuote(path)} -maxdepth 1 -mindepth 1 -printf ${shellQuote(FIND_FMT)}`,
    );
    if (exitCode !== 0) {
      if (stderr.includes("No such") || stderr.toLowerCase().includes("cannot access")) {
        throw new DaytonaNotFoundError(`path ${path} not found`, { statusCode: 404 });
      }
      throw new FileSystemError(`listFiles(${path}) failed: ${stderr.trim()}`);
    }
    const entries: FileInfo[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const parsed = parseFindLine(line);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  async createFolder(path: string, mode: string): Promise<void> {
    const { stderr, exitCode } = await this.shell(`mkdir -m ${shellQuote(mode)} -p ${shellQuote(path)}`);
    if (exitCode !== 0) {
      throw new FileSystemError(`createFolder(${path}) failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }
  }

  async deleteFile(path: string, recursive: boolean = false): Promise<void> {
    const flag = recursive ? "-rf" : "-f";
    const { stderr, exitCode } = await this.shell(`rm ${flag} ${shellQuote(path)}`);
    if (exitCode !== 0) {
      throw new FileSystemError(`deleteFile(${path}) failed: ${stderr.trim()}`);
    }
  }

  async getFileInfo(path: string): Promise<FileInfo> {
    const { stdout, stderr, exitCode } = await this.shell(
      `find ${shellQuote(path)} -maxdepth 0 -printf ${shellQuote(FIND_FMT)}`,
    );
    if (exitCode !== 0 || !stdout.trim()) {
      if (stderr.includes("No such") || stderr.toLowerCase().includes("cannot access")) {
        throw new DaytonaNotFoundError(`path ${path} not found`, { statusCode: 404 });
      }
      throw new FileSystemError(`getFileInfo(${path}) failed: ${stderr.trim() || "not found"}`);
    }
    const parsed = parseFindLine(stdout.split("\n")[0]!);
    if (!parsed) throw new FileSystemError(`getFileInfo(${path}): unparseable find output`);
    return { ...parsed, name: basename(path) || path };
  }

  async moveFiles(source: string, destination: string): Promise<void> {
    const { stderr, exitCode } = await this.shell(`mv ${shellQuote(source)} ${shellQuote(destination)}`);
    if (exitCode !== 0) {
      throw new FileSystemError(`moveFiles(${source}, ${destination}) failed: ${stderr.trim()}`);
    }
  }

  /** Substring (literal) match — daytona's daemon uses strings.Contains. */
  async findFiles(path: string, pattern: string): Promise<Match[]> {
    const cmd = `grep -rnF --no-messages ${shellQuote(pattern)} ${shellQuote(path)}`;
    const { stdout, exitCode } = await this.shell(cmd);
    // grep exit 1 = no matches; not an error.
    if (exitCode !== 0 && exitCode !== 1) {
      throw new FileSystemError(`findFiles failed: exit ${exitCode}`);
    }
    const matches: Match[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);
      if (firstColon < 0 || secondColon < 0) continue;
      const file = line.slice(0, firstColon);
      const lineNo = Number(line.slice(firstColon + 1, secondColon)) || 0;
      const content = line.slice(secondColon + 1);
      matches.push({ file, line: lineNo, content });
    }
    return matches;
  }

  async setFilePermissions(
    path: string,
    opts: { mode?: string; owner?: string; group?: string } = {},
  ): Promise<void> {
    const { mode, owner, group } = opts;
    if (mode == null && owner == null && group == null) return;
    if (mode != null) {
      const { stderr, exitCode } = await this.shell(`chmod ${shellQuote(mode)} ${shellQuote(path)}`);
      if (exitCode !== 0) throw new FileSystemError(`chmod failed: ${stderr.trim()}`);
    }
    if (owner != null || group != null) {
      const target = `${owner ?? ""}:${group ?? ""}`;
      const { stderr, exitCode } = await this.shell(`chown ${shellQuote(target)} ${shellQuote(path)}`);
      if (exitCode !== 0) throw new FileSystemError(`chown failed: ${stderr.trim()}`);
    }
  }

  // ---- Not implemented (loud) ----

  async searchFiles(_path: string, _pattern: string): Promise<SearchFilesResponse> {
    throw new Error(
      "arker.daytona: fs.searchFiles is not implemented — " +
        "use fs.findFiles (content grep) or fs.listFiles for now.",
    );
  }

  async replaceInFiles(
    _files: string[],
    _pattern: string,
    _newValue: string,
  ): Promise<ReplaceResult[]> {
    throw new Error(
      "arker.daytona: fs.replaceInFiles is not implemented — " +
        "regex flavor mismatch risk.",
    );
  }

  async uploadFiles(..._args: unknown[]): Promise<void> {
    throw new Error("arker.daytona: fs.uploadFiles (batch) is not implemented — loop fs.uploadFile.");
  }

  async uploadFileStream(..._args: unknown[]): Promise<void> {
    throw new Error("arker.daytona: fs.uploadFileStream is not implemented.");
  }

  async downloadFileStream(..._args: unknown[]): Promise<void> {
    throw new Error("arker.daytona: fs.downloadFileStream is not implemented.");
  }

  async downloadFiles(..._args: unknown[]): Promise<void> {
    throw new Error("arker.daytona: fs.downloadFiles (batch) is not implemented.");
  }

  // ---- Internals ----

  private async shell(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = (await this.sbx._computer.run(cmd)) as CompletedRunResult;
    if (result.type !== "completed") {
      throw new FileSystemError(`unexpected run result type ${result.type}`);
    }
    return {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      exitCode: result.exitCode,
    };
  }
}
