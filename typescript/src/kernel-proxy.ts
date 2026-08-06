import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { BlockList, connect as connectTcp, isIP, type AddressInfo, type Socket } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { connect as connectTls } from "node:tls";

import { WebSocket, WebSocketServer } from "ws";

import { Arker, ArkerError, type CompletedRunResult, type PtyConnection, type VM } from "./index.js";

const METADATA_PREFIX = "arker-kernel-v1:";
const METADATA_PATH = "/opt/arker-kernel/session.json";
const DEFAULT_SOURCE = "ubuntu-full";
const DEFAULT_BASE_URL = "https://aws-us-east-1.arker.ai/api";
const DEFAULT_KERNEL_BASE_URL = "https://api.onkernel.com";
const DEFAULT_SETUP_TIMEOUT_SECONDS = 1_800;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MAX_PENDING_WEBSOCKET_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FILESYSTEM_WATCH_EVENTS = 10_000;
const MAX_TIMEOUT_SECONDS = 259_200;
const MAX_TIMEOUT_MS = MAX_TIMEOUT_SECONDS * 1_000;
const STATE_VERSION = 1;
const EMPTY_PROFILE_ARCHIVE = Buffer.alloc(0);
const SERVICE_SESSION_INDEX = 1;
const CREATION_RECONCILE_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 300_000, 600_000] as const;
type CapabilityKind = "bidi" | "cdp" | "direct" | "live";

const NON_PUBLIC_PROXY_CHECK_TARGETS_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_PROXY_CHECK_TARGETS_V4.addSubnet(network, prefix, "ipv4");
const NON_PUBLIC_PROXY_CHECK_TARGETS_V6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["100::", 64],
  ["2001:2::", 48], ["2001:10::", 28], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NON_PUBLIC_PROXY_CHECK_TARGETS_V6.addSubnet(network, prefix, "ipv6");
const GLOBAL_IPV6_PROXY_CHECK_TARGETS = new BlockList();
GLOBAL_IPV6_PROXY_CHECK_TARGETS.addSubnet("2000::", 3, "ipv6");

export interface KernelProxyOptions {
  /** Existing Arker client. Primarily useful for embedding and tests. */
  arker?: Arker;
  /** Arker credential. Defaults to ARKER_API_KEY. */
  arkerApiKey?: string;
  /** Regional Arker compute endpoint. */
  arkerBaseUrl?: string;
  /** Public Arker VM/golden to fork for every Kernel browser. */
  sourceVmName?: string;
  /** Exact prepared Arker VM ID to fork instead of resolving a source name. */
  sourceVmId?: string;
  /** State layers inherited from the source. Use `["disk"]` for a prepared cold boot. */
  sourceLayers?: Array<"disk" | "memory">;
  /** Arker platform preference. Defaults to x86_64 `icelake` for CloakBrowser v146. */
  sourcePlatforms?: string[];
  /** Path to an edited copy of scripts/kernel-proxy/setup-cloakbrowser.sh. */
  setupScriptPath?: string;
  /** Skip VM package/browser setup. Intended only for translator unit tests. */
  skipSetup?: boolean;
  /** CloakBrowser npm wrapper version installed in the guest. */
  cloakbrowserNpmVersion?: string;
  /** CloakBrowser binary version. Defaults to the tested v146 pin; review its separate binary license. */
  cloakbrowserBinaryVersion?: string;
  /** Optional CloakBrowser license key for a current licensed binary. */
  cloakbrowserLicenseKey?: string;
  /** Additional Chromium flags injected by the guest launcher. */
  browserArgs?: string[];
  /** Bind address. Defaults to loopback. */
  host?: string;
  /** Bind port. Zero asks the OS for an available port. */
  port?: number;
  /** Externally reachable proxy origin used in returned CDP/direct/live-view URLs. */
  publicBaseUrl?: string;
  /** Optional bearer token required by the Kernel-compatible REST API. */
  apiKey?: string;
  /** Stable HMAC secret for CDP/direct/live-view capability URLs. */
  signingSecret?: string;
  /** Guest setup timeout. */
  setupTimeoutSeconds?: number;
  /** Memory available while installing the guest browser stack. Defaults to 4096 MiB. */
  setupMemoryMib?: number;
  /** Optional steady-state VM memory target after setup. */
  runtimeMemoryMib?: number;
  /** Optional steady-state VM vCPU target after setup. */
  runtimeVcpu?: number;
  /** Attempts for transient browser-creation failures. Defaults to 3. */
  createAttempts?: number;
  /** Release Arker CPU+memory after the coalescing idle window. Defaults to true. */
  automaticStandby?: boolean;
  /** Coalesce nearby requests before automatic standby. Defaults to 5000 ms, matching Kernel. Set 0 to checkpoint after every operation. */
  standbyDelayMs?: number;
  /** Durable registry and blob directory for Kernel profiles, extensions, proxies, and pools. */
  stateDirectory?: string;
  /** Optional session-affine traffic split between Kernel and Arker. */
  hybridRouting?: KernelHybridRoutingOptions;
}

export interface KernelHybridRoutingOptions {
  /** Kernel credential used only for upstream requests. Defaults to KERNEL_UPSTREAM_API_KEY. */
  kernelApiKey?: string;
  /** Kernel REST origin. Defaults to https://api.onkernel.com. */
  kernelBaseUrl?: string;
  /** Percentage of new browser sessions created by Kernel. The remainder are fresh Arker forks. */
  kernelTrafficPercent?: number;
  /** Fall back to Arker for explicit retryable Kernel create responses. Defaults to true. */
  fallbackToArkerOnCreateError?: boolean;
  /** Retry a browser-scoped request in Arker when Kernel returns 404. Defaults on when an upstream key is configured. */
  fallbackToArkerOnNotFound?: boolean;
  /** Also fall back after ambiguous Kernel network failures. Disabled by default to avoid duplicate creates. */
  fallbackToArkerOnTransportError?: boolean;
  /** Overall Kernel request timeout. Defaults to 30000 ms. */
  kernelRequestTimeoutMs?: number;
}

interface BrowserMetadata {
  version: 1;
  headless: boolean;
  stealth: boolean;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  name?: string;
  startUrl?: string;
  tags?: Record<string, string>;
  viewport?: { width: number; height: number; refresh_rate?: number };
  kioskMode?: boolean;
  cdpPath: string;
  bidiPath?: string;
  hostname: string;
  creationToken?: string;
  mouse?: { x: number; y: number };
  clipboard?: string;
  cursorHidden?: boolean;
  telemetry?: unknown;
  chromePolicy?: Record<string, unknown>;
  profile?: { id: string; name?: string; createdAt?: string };
  profileSaveChanges?: boolean;
  proxyId?: string;
  extensionIds?: string[];
  pool?: { id: string; name?: string; state: "idle" | "leased"; baselineTelemetry?: unknown };
}

interface BrowserRecord {
  vm: VM;
  metadata: BrowserMetadata;
}

interface GuestEndpoints {
  cdpPath: string;
  bidiPath: string;
}

interface PreparedRuntimeCache extends GuestEndpoints {
  sourceVmId: string;
  setupFingerprint: string;
  configFingerprint: string;
}

interface CreationReconciliation {
  createdAtMs: number;
  scanIndex: number;
  pendingRequests: number;
  activeVmIds: Set<string>;
  keepVmId?: string;
}

interface KernelBrowserCreate {
  headless?: boolean;
  stealth?: boolean;
  timeout_seconds?: number;
  name?: string;
  start_url?: string;
  tags?: Record<string, string>;
  viewport?: { width?: number; height?: number; refresh_rate?: number };
  kiosk_mode?: boolean;
  invocation_id?: string;
  gpu?: boolean;
  proxy_id?: string;
  profile?: unknown;
  extensions?: unknown[];
  telemetry?: unknown;
  chrome_policy?: Record<string, unknown>;
}

interface StoredProfile {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt?: string;
  lastUsedAt?: string;
  hasArchive: boolean;
}

interface StoredExtension {
  id: string;
  name?: string;
  createdAt: string;
  lastUsedAt?: string;
  sizeBytes: number;
  checksum: string;
}

interface StoredProxy {
  id: string;
  type: "custom";
  name?: string;
  protocol: "http" | "https";
  bypassHosts: string[];
  config: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    caBundle?: string;
  };
  status?: "available" | "unavailable";
  lastChecked?: string;
  ipAddress?: string;
}

interface StoredBrowserPool {
  id: string;
  name?: string;
  createdAt: string;
  config: Record<string, unknown> & { size: number };
  extensionIds: string[];
  profileId?: string;
  idleSessionIds: string[];
  leasedSessionIds: string[];
}

type BrowserProvider = "arker" | "kernel";

interface StoredBrowserRoute {
  sessionId: string;
  name?: string;
  provider: BrowserProvider;
  updatedAt: string;
}

interface KernelProxyState {
  version: 1;
  profiles: StoredProfile[];
  extensions: StoredExtension[];
  proxies: StoredProxy[];
  browserPools: StoredBrowserPool[];
  browserRoutes: StoredBrowserRoute[];
}

interface ResolvedKernelHybridRoutingOptions {
  kernelApiKey?: string;
  kernelBaseUrl: string;
  kernelTrafficPercent: number;
  fallbackToArkerOnCreateError: boolean;
  fallbackToArkerOnNotFound: boolean;
  fallbackToArkerOnTransportError: boolean;
  kernelRequestTimeoutMs: number;
}

interface KernelUpstreamResponse {
  response: Response;
  cancelTimeout: () => void;
  timedOut: () => boolean;
}

interface BrowserAssociations {
  profile?: { record: StoredProfile; archive?: Buffer; saveChanges: boolean };
  extensions: Array<{ record: StoredExtension; archive: Buffer }>;
  proxy?: StoredProxy;
}

interface ProcessParams {
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  as_user?: string | null;
  as_root?: boolean;
  timeout_sec?: number | null;
  allocate_tty?: boolean;
  cols?: number;
  rows?: number;
}

interface InteractiveProcess {
  vm: VM;
  connection: PtyConnection;
  output: Array<{ sequence: number; data: Buffer }>;
  outputBytes: number;
  nextOutputSequence: number;
  state: "running" | "exited";
  exitCode: number | null;
  timeout?: ReturnType<typeof setTimeout>;
  pinHeld?: boolean;
}

interface FilesystemWatch {
  vm: VM;
  vmId: string;
  path: string;
  recursive: boolean;
  events: Array<{ sequence: number; data: Record<string, unknown> }>;
  nextSequence: number;
  eventPath: string;
  pidPath: string;
  byteOffset: number;
  pollTimer?: ReturnType<typeof setInterval>;
  polling: boolean;
  lineBuffer: string;
  closed: boolean;
}

interface DetachedProcess {
  vm: VM;
  runId: string;
  sessionId?: string;
  signalPath: string;
  pinHeld?: boolean;
}

interface BrowserReplay {
  vm: VM;
  directory: string;
  outputPath: string;
  recordAudio: boolean;
  audioPath?: string;
  audioPidPath?: string;
  fps: number;
  maxDurationSeconds: number;
  expiresAtMs: number;
  startedAt: string;
  finishedAt?: string;
  frame: number;
  capture?: Promise<void>;
  finishing?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  maxTimer?: ReturnType<typeof setTimeout>;
}

class KernelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const REQUEST_BODY_CACHE = new WeakMap<IncomingMessage, Buffer>();

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function envBoolean(name: string, configured: boolean | undefined, fallback: boolean): boolean {
  if (configured !== undefined) return configured;
  const value = env(name);
  if (value === undefined) return fallback;
  if (/^(?:1|true|yes)$/i.test(value)) return true;
  if (/^(?:0|false|no)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function httpOrigin(value: string, label: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${label} must be a valid http or https URL`);
  }
}

function isRetryableKernelCreateStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function isLikelyArkerBrowserReference(value: string): boolean {
  return value.startsWith("vmh-")
    || value.startsWith("vm_")
    || /^[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9-]+$/i.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertPath(value: unknown, label = "path"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    throw new KernelHttpError(422, "validation_error", `${label} must be an absolute path`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KernelHttpError(422, "validation_error", `${label} must be a finite number`);
  }
  return value;
}

function fileMode(value: unknown, label = "mode"): string {
  if (typeof value !== "string" || !/^[0-7]{3,4}$/.test(value)) {
    throw new KernelHttpError(422, "validation_error", `${label} must be a three- or four-digit octal string`);
  }
  return value;
}

function unixIdentity(value: unknown, label: "owner" | "group" | "as_user"): string {
  if (typeof value !== "string" || !value || !/^(?:[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+)$/.test(value)) {
    throw new KernelHttpError(422, "validation_error", `${label} must be a username, group name, UID, or GID`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new KernelHttpError(422, "validation_error", "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function resourceName(value: unknown, label = "name"): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new KernelHttpError(422, "validation_error", `${label} must be 1-255 letters, numbers, dots, underscores, or hyphens`);
  }
  return value;
}

function selector(value: unknown, label: string): { id?: string; name?: string } {
  const object = asObject(value);
  const id = object.id;
  const name = object.name;
  if ((id === undefined) === (name === undefined)) {
    throw new KernelHttpError(422, "validation_error", `${label} must provide exactly one of id or name`);
  }
  if (id !== undefined && (typeof id !== "string" || !id)) {
    throw new KernelHttpError(422, "validation_error", `${label}.id must be a non-empty string`);
  }
  if (name !== undefined) resourceName(name, `${label}.name`);
  return id !== undefined ? { id: String(id) } : { name: String(name) };
}

function isZipArchive(value: Uint8Array): boolean {
  return value.length >= 4 && value[0] === 0x50 && value[1] === 0x4b
    && ((value[2] === 0x03 && value[3] === 0x04) || (value[2] === 0x05 && value[3] === 0x06) || (value[2] === 0x07 && value[3] === 0x08));
}

function crxZipPayload(value: Uint8Array): Buffer {
  const body = Buffer.from(value);
  if (isZipArchive(body)) return body;
  if (body.length < 16 || body.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new KernelHttpError(502, "invalid_extension_archive", "Chrome Web Store returned neither CRX nor ZIP data");
  }
  const version = body.readUInt32LE(4);
  let offset: number;
  if (version === 2) offset = 16 + body.readUInt32LE(8) + body.readUInt32LE(12);
  else if (version === 3) offset = 12 + body.readUInt32LE(8);
  else throw new KernelHttpError(502, "invalid_extension_archive", `Unsupported CRX version ${version}`);
  const archive = body.subarray(offset);
  if (!isZipArchive(archive)) throw new KernelHttpError(502, "invalid_extension_archive", "CRX payload does not contain a ZIP archive");
  return archive;
}

function readSocketHeaders(socket: Socket, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolveHeaders, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("proxy check timed out")), timeoutMs);
    const finish = (error?: Error, headers?: string) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error);
      else resolveHeaders(headers || "");
    };
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024) return finish(new Error("proxy response headers exceed 64 KiB"));
      const end = buffer.indexOf("\r\n\r\n");
      if (end >= 0) finish(undefined, buffer.subarray(0, end).toString("latin1"));
    };
    socket.on("error", onError);
    socket.on("data", onData);
  });
}

async function checkCustomProxy(proxy: StoredProxy, target: URL): Promise<boolean> {
  const socket = await new Promise<Socket>((resolveSocket, reject) => {
    const options = { host: proxy.config.host, port: proxy.config.port };
    const candidate = proxy.protocol === "https"
      ? connectTls({ ...options, ...(proxy.config.caBundle ? { ca: proxy.config.caBundle } : {}) })
      : connectTcp(options);
    const timer = setTimeout(() => candidate.destroy(new Error("proxy connection timed out")), 10_000);
    const event = proxy.protocol === "https" ? "secureConnect" : "connect";
    candidate.once(event, () => { clearTimeout(timer); resolveSocket(candidate); });
    candidate.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    const credentials = proxy.config.username === undefined ? "" : Buffer.from(`${proxy.config.username}:${proxy.config.password || ""}`).toString("base64");
    const authorization = credentials ? `Proxy-Authorization: Basic ${credentials}\r\n` : "";
    if (target.protocol === "https:") {
      socket.write(`CONNECT ${target.hostname}:${target.port || "443"} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || "443"}\r\n${authorization}Connection: close\r\n\r\n`);
    } else {
      socket.write(`HEAD ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\n${authorization}Connection: close\r\n\r\n`);
    }
    const headers = await readSocketHeaders(socket);
    const status = Number(headers.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1]);
    return status >= 200 && status < 400;
  } finally {
    socket.destroy();
  }
}

function isPublicProxyCheckAddress(address: string, family: number): boolean {
  if (family === 4) return !NON_PUBLIC_PROXY_CHECK_TARGETS_V4.check(address, "ipv4");
  return family === 6
    && GLOBAL_IPV6_PROXY_CHECK_TARGETS.check(address, "ipv6")
    && !NON_PUBLIC_PROXY_CHECK_TARGETS_V6.check(address, "ipv6");
}

async function requirePublicProxyCheckTarget(target: URL): Promise<void> {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new KernelHttpError(422, "validation_error", "url must resolve to a public IP address");
  }
  if (addresses.length === 0 || addresses.some(({ address, family }) => !isPublicProxyCheckAddress(address, family))) {
    throw new KernelHttpError(422, "validation_error", "url must resolve only to public IP addresses");
  }
}

/** A valid Zstandard frame composed of uncompressed raw blocks. */
function zstdRawFrame(value: Uint8Array): Buffer {
  const body = Buffer.from(value);
  let descriptor: number;
  let frameSize: Buffer;
  if (body.length < 256) {
    descriptor = 0x20;
    frameSize = Buffer.from([body.length]);
  } else if (body.length < 65_792) {
    descriptor = 0x60;
    frameSize = Buffer.alloc(2);
    frameSize.writeUInt16LE(body.length - 256);
  } else if (body.length <= 0xffff_ffff) {
    descriptor = 0xa0;
    frameSize = Buffer.alloc(4);
    frameSize.writeUInt32LE(body.length);
  } else {
    descriptor = 0xe0;
    frameSize = Buffer.alloc(8);
    frameSize.writeBigUInt64LE(BigInt(body.length));
  }
  const blocks: Buffer[] = [];
  for (let offset = 0; offset < body.length || offset === 0; offset += 0x1ffff) {
    const chunk = body.subarray(offset, Math.min(body.length, offset + 0x1ffff));
    const last = offset + chunk.length >= body.length;
    const header = Buffer.alloc(3);
    header.writeUIntLE((chunk.length << 3) | (last ? 1 : 0), 0, 3);
    blocks.push(header, chunk);
    if (last) break;
  }
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, descriptor]), frameSize, ...blocks]);
}

function parseTags(value: unknown): Record<string, string> {
  const tags = asObject(value);
  const entries = Object.entries(tags);
  if (entries.length > 50 || entries.some(([key, item]) => !key || typeof item !== "string")) {
    throw new KernelHttpError(422, "validation_error", "tags must contain at most 50 non-empty string pairs");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseChromePolicy(value: unknown): Record<string, unknown> {
  const policy = asObject(value);
  const blocked = Object.keys(policy).find((key) =>
    /^(?:Extension|Proxy|RemoteDebugging)/.test(key) || key === "DeveloperToolsAvailability"
  );
  if (blocked) {
    throw new KernelHttpError(422, "unsupported_operation", `chrome_policy.${blocked} is managed by the browser proxy`);
  }
  return policy;
}

const TELEMETRY_CATEGORIES = ["captcha", "connection", "console", "control", "interaction", "network", "page", "screenshot", "system"] as const;
const TELEMETRY_DEFAULT_CATEGORIES = new Set<string>(["captcha", "connection", "control", "system"]);
type TelemetryCategory = typeof TELEMETRY_CATEGORIES[number];
type TelemetryBrowserConfig = Partial<Record<TelemetryCategory, { enabled: boolean }>>;

function parseTelemetryRequest(value: unknown): { enabled?: boolean; browser?: TelemetryBrowserConfig; empty: boolean } {
  const request = asObject(value);
  if (Object.keys(request).some((key) => key !== "enabled" && key !== "browser")) {
    throw new KernelHttpError(422, "validation_error", "telemetry only accepts enabled and browser");
  }
  if (request.enabled !== undefined && typeof request.enabled !== "boolean") {
    throw new KernelHttpError(422, "validation_error", "telemetry.enabled must be a boolean");
  }
  let browser: TelemetryBrowserConfig | undefined;
  if (request.browser !== undefined) {
    if (request.browser === null) throw new KernelHttpError(422, "validation_error", "telemetry.browser must be an object");
    const categories = asObject(request.browser);
    browser = {};
    for (const [category, rawConfig] of Object.entries(categories)) {
      if (!TELEMETRY_CATEGORIES.includes(category as TelemetryCategory)) {
        throw new KernelHttpError(422, "validation_error", `unknown telemetry category ${category}`);
      }
      if (rawConfig === null) {
        throw new KernelHttpError(422, "validation_error", `telemetry.browser.${category} must be an object`);
      }
      const config = asObject(rawConfig);
      if (Object.keys(config).some((key) => key !== "enabled") || (config.enabled !== undefined && typeof config.enabled !== "boolean")) {
        throw new KernelHttpError(422, "validation_error", `telemetry.browser.${category}.enabled must be a boolean`);
      }
      browser[category as TelemetryCategory] = {
        enabled: config.enabled ?? TELEMETRY_DEFAULT_CATEGORIES.has(category),
      };
    }
  }
  if (request.enabled === false && browser && Object.keys(browser).length > 0) {
    throw new KernelHttpError(422, "validation_error", "telemetry.enabled=false cannot be combined with browser categories");
  }
  return {
    ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
    ...(browser === undefined ? {} : { browser }),
    empty: request.enabled === undefined && (!browser || Object.keys(browser).length === 0),
  };
}

function telemetryDefaults(): TelemetryBrowserConfig {
  return Object.fromEntries([...TELEMETRY_DEFAULT_CATEGORIES].map((category) => [category, { enabled: true }])) as TelemetryBrowserConfig;
}

function activeTelemetry(browser: TelemetryBrowserConfig): Record<string, unknown> {
  const enabled = Object.values(browser).some((category) => category?.enabled);
  return {
    ...(enabled ? { browser } : {}),
    export: { otlp: { enabled: false } },
  };
}

function telemetryOnCreate(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  const request = parseTelemetryRequest(value);
  if (request.empty) return undefined;
  if (request.enabled === false) return activeTelemetry({});
  const browser = telemetryDefaults();
  Object.assign(browser, request.browser);
  return activeTelemetry(browser);
}

function telemetryOnUpdate(current: unknown, value: unknown): unknown {
  if (value == null) return current;
  const request = parseTelemetryRequest(value);
  if (request.empty) return current;
  if (request.enabled === false) return activeTelemetry({});
  const currentBrowser = current && typeof current === "object" && !Array.isArray(current)
    ? (current as { browser?: TelemetryBrowserConfig }).browser
    : undefined;
  const browser = request.enabled === true ? telemetryDefaults() : { ...(currentBrowser ?? telemetryDefaults()) };
  Object.assign(browser, request.browser);
  return activeTelemetry(browser);
}

function decodeMetadata(description: unknown): BrowserMetadata | null {
  if (typeof description !== "string" || !description.startsWith(METADATA_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(description.slice(METADATA_PREFIX.length), "base64url").toString("utf8"));
    return parsed?.version === 1 ? (parsed as BrowserMetadata) : null;
  } catch {
    return null;
  }
}

function insertPort(hostname: string, port: number): string {
  const dot = hostname.indexOf(".");
  if (dot < 0) return `${hostname}-${port}`;
  return `${hostname.slice(0, dot)}-${port}${hostname.slice(dot)}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function contentType(req: IncomingMessage): string {
  return String(req.headers["content-type"] || "").split(";", 1)[0]!.trim().toLowerCase();
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const cached = REQUEST_BODY_CACHE.get(req);
  if (cached) {
    if (cached.length > limit) throw new KernelHttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
    return cached;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new KernelHttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);
  REQUEST_BODY_CACHE.set(req, body);
  return body;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (body.length === 0) return {};
  try {
    return asObject(JSON.parse(body.toString("utf8")));
  } catch (error) {
    if (error instanceof KernelHttpError) throw error;
    throw new KernelHttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  res.end(body);
}

function sendBinary(res: ServerResponse, status: number, value: Uint8Array, type = "application/octet-stream"): void {
  const body = Buffer.from(value);
  res.writeHead(status, { "content-type": type, "content-length": String(body.length) });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status = 204): void {
  res.writeHead(status);
  res.end();
}

function kernelErrorBody(code: string, message: string): unknown {
  return {
    error: {
      code,
      message,
      type: code === "validation_error" ? "invalid_request_error" : "api_error",
    },
  };
}

function mapError(error: unknown): KernelHttpError {
  if (error instanceof KernelHttpError) return error;
  if (error instanceof ArkerError) {
    const status = error.status === 404 ? 404 : error.status === 401 || error.status === 403 ? error.status : 502;
    return new KernelHttpError(status, error.code, error.message.replace(/^[^:]+:\s*/, ""));
  }
  return new KernelHttpError(500, "internal_error", error instanceof Error ? error.message : "internal error");
}

function isTransientArkerCreateFailure(error: unknown): boolean {
  if (!(error instanceof ArkerError)) return false;
  if (error.status === 0 || error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429) return true;
  if (error.status >= 500) return true;
  return error.status === 404 && /(?:not found|deleted)/i.test(error.message);
}

function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function runBytes(result: CompletedRunResult, field: "stdout" | "stderr"): Uint8Array {
  return field === "stdout" ? result.stdoutBytes : result.stderrBytes;
}

function runText(result: CompletedRunResult, field: "stdout" | "stderr"): string {
  return new TextDecoder().decode(runBytes(result, field));
}

function commandFor(params: ProcessParams): string {
  if (!params.command || typeof params.command !== "string") {
    throw new KernelHttpError(422, "validation_error", "command is required");
  }
  let command = [params.command, ...(params.args ?? [])]
    .map((part) => shellQuote(String(part)))
    .join(" ");
  if (params.env) {
    const assignments = Object.entries(params.env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new KernelHttpError(422, "validation_error", `invalid environment variable name: ${key}`);
      }
      return `${key}=${shellQuote(String(value))}`;
    });
    if (assignments.length > 0) command = `env ${assignments.join(" ")} ${command}`;
  }
  if (params.cwd != null) command = `cd ${shellQuote(assertPath(params.cwd, "cwd"))} && ${command}`;
  if (params.as_user && params.as_user !== "root") {
    command = `runuser -u ${shellQuote(unixIdentity(params.as_user, "as_user"))} -- /bin/bash -lc ${shellQuote(command)}`;
  }
  return command;
}

function parseProcessParams(value: Record<string, unknown>): ProcessParams {
  if (typeof value.command !== "string" || !value.command) {
    throw new KernelHttpError(422, "validation_error", "command is required");
  }
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((item) => typeof item !== "string"))) {
    throw new KernelHttpError(422, "validation_error", "args must be an array of strings");
  }
  if (value.env !== undefined) {
    const variables = asObject(value.env);
    if (Object.values(variables).some((item) => typeof item !== "string")) {
      throw new KernelHttpError(422, "validation_error", "env values must be strings");
    }
  }
  for (const field of ["as_root", "allocate_tty"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new KernelHttpError(422, "validation_error", `${field} must be a boolean`);
    }
  }
  if (value.as_user !== undefined && value.as_user !== null && typeof value.as_user !== "string") {
    throw new KernelHttpError(422, "validation_error", "as_user must be a string or null");
  }
  if (typeof value.as_user === "string") unixIdentity(value.as_user, "as_user");
  if (value.as_root === true && typeof value.as_user === "string" && value.as_user !== "root") {
    throw new KernelHttpError(422, "validation_error", "as_root cannot be combined with a non-root as_user");
  }
  if (value.timeout_sec !== undefined && value.timeout_sec !== null) {
    if (typeof value.timeout_sec !== "number" || !Number.isFinite(value.timeout_sec) || value.timeout_sec <= 0 || value.timeout_sec > MAX_TIMEOUT_SECONDS) {
      throw new KernelHttpError(422, "validation_error", `timeout_sec must be greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`);
    }
  }
  for (const field of ["cols", "rows"] as const) {
    if (value[field] !== undefined && (!Number.isInteger(value[field]) || Number(value[field]) <= 0)) {
      throw new KernelHttpError(422, "validation_error", `${field} must be a positive integer`);
    }
  }
  if (value.cwd !== undefined && value.cwd !== null) assertPath(value.cwd, "cwd");
  return value as ProcessParams;
}

function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new KernelHttpError(422, "validation_error", `${label} must be valid base64`);
  }
  return Buffer.from(value, "base64");
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of String(req.headers.cookie || "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return result;
}

function relayWebSocketClose(socket: WebSocket, code: number, reason: Buffer): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  const valid = code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  if (!valid || socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else socket.close(code, reason);
}

function rawWebSocketBytes(data: WebSocket.RawData): number {
  return Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
}

export class KernelProxy {
  readonly server: Server;
  readonly options: Required<Pick<KernelProxyOptions, "host" | "port" | "sourceVmName" | "setupTimeoutSeconds" | "setupMemoryMib" | "createAttempts" | "stateDirectory">> & KernelProxyOptions;

  private readonly arker: Arker;
  private readonly forwardApiKey: string;
  private readonly signingSecret: string;
  private readonly hybridRouting: ResolvedKernelHybridRoutingOptions;
  private readonly browserProviders = new Map<string, BrowserProvider>();
  private readonly browserRouteNames = new Map<string, string>();
  private readonly cache = new Map<string, BrowserRecord>();
  private readonly interactiveProcesses = new Map<string, InteractiveProcess>();
  private readonly detachedProcesses = new Map<string, DetachedProcess>();
  private readonly filesystemWatches = new Map<string, FilesystemWatch>();
  private readonly browserReplays = new Map<string, BrowserReplay>();
  private readonly activeBrowserConnections = new Map<string, number>();
  private readonly activeLiveConnections = new Map<string, number>();
  private readonly streamingResponses = new Set<ServerResponse>();
  private readonly serverSockets = new Set<Socket>();
  private readonly vmControlQueues = new Map<string, Promise<void>>();
  private readonly vmPinStateQueues = new Map<string, Promise<void>>();
  private readonly vmPinCounts = new Map<string, number>();
  private readonly knownAwakeVms = new Set<string>();
  private preparedRuntimeCache?: PreparedRuntimeCache;
  private readonly vmStandbyTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; vm: VM }>();
  private readonly reservedNames = new Set<string>();
  private readonly creationReconciliations = new Map<string, CreationReconciliation>();
  private stateQueue: Promise<void> = Promise.resolve();
  private readonly poolFillQueues = new Map<string, Promise<void>>();
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private readonly upstreamWebSockets = new Set<WebSocket>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private lastSweepDiscoveryAt = 0;
  private sweeping = false;
  private closing = false;

  private debugTiming(stage: string, startedAt: number, details: Record<string, unknown> = {}): void {
    if (!/^(?:1|true|yes)$/i.test(env("KERNEL_PROXY_DEBUG_TIMING") ?? "")) return;
    process.stderr.write(`${JSON.stringify({
      component: "arker-kernel-proxy",
      event: "timing",
      stage,
      duration_ms: Number((performance.now() - startedAt).toFixed(2)),
      ...details,
    })}\n`);
  }

  constructor(options: KernelProxyOptions = {}) {
    const host = options.host ?? env("KERNEL_PROXY_HOST") ?? "127.0.0.1";
    const port = options.port ?? Number(env("KERNEL_PROXY_PORT") ?? "8787");
    const sourceVmName = options.sourceVmName ?? env("KERNEL_PROXY_ARKER_SOURCE") ?? DEFAULT_SOURCE;
    const sourcePlatforms = options.sourcePlatforms ?? (env("KERNEL_PROXY_ARKER_PLATFORMS") || "icelake").split(",").map((value) => value.trim()).filter(Boolean);
    const setupTimeoutSeconds = options.setupTimeoutSeconds ?? DEFAULT_SETUP_TIMEOUT_SECONDS;
    const setupMemoryMib = options.setupMemoryMib ?? Number(env("KERNEL_PROXY_SETUP_MEMORY_MIB") ?? "4096");
    const runtimeMemoryMib = options.runtimeMemoryMib ?? (env("KERNEL_PROXY_RUNTIME_MEMORY_MIB") ? Number(env("KERNEL_PROXY_RUNTIME_MEMORY_MIB")) : undefined);
    const runtimeVcpu = options.runtimeVcpu ?? (env("KERNEL_PROXY_RUNTIME_VCPU") ? Number(env("KERNEL_PROXY_RUNTIME_VCPU")) : undefined);
    const createAttempts = options.createAttempts ?? Number(env("KERNEL_PROXY_CREATE_ATTEMPTS") ?? "3");
    const automaticStandbySetting = env("KERNEL_PROXY_AUTOMATIC_STANDBY");
    const automaticStandby = options.automaticStandby
      ?? (automaticStandbySetting === undefined || !/^(?:0|false|no)$/i.test(automaticStandbySetting));
    const standbyDelayMs = options.standbyDelayMs ?? Number(env("KERNEL_PROXY_STANDBY_DELAY_MS") ?? "5000");
    const configuredStateDirectory = options.stateDirectory ?? env("KERNEL_PROXY_STATE_DIR") ?? ".arker-kernel-proxy";
    if (typeof configuredStateDirectory !== "string" || !configuredStateDirectory.trim() || configuredStateDirectory.includes("\0")) {
      throw new Error("Kernel proxy state directory must be a non-empty path");
    }
    const stateDirectory = resolve(configuredStateDirectory);
    const arkerApiKey = options.arkerApiKey ?? env("ARKER_API_KEY") ?? "";
    const arkerBaseUrl = options.arkerBaseUrl ?? env("ARKER_BASE_URL") ?? DEFAULT_BASE_URL;
    const apiKey = options.apiKey ?? env("KERNEL_PROXY_API_KEY");
    const signingSecret = options.signingSecret ?? env("KERNEL_PROXY_SIGNING_SECRET") ?? randomBytes(32).toString("base64url");
    const hybrid = options.hybridRouting ?? {};
    const kernelApiKey = hybrid.kernelApiKey ?? env("KERNEL_UPSTREAM_API_KEY");
    const kernelBaseUrl = httpOrigin(hybrid.kernelBaseUrl ?? env("KERNEL_UPSTREAM_BASE_URL") ?? DEFAULT_KERNEL_BASE_URL, "Kernel upstream URL");
    const kernelTrafficPercent = hybrid.kernelTrafficPercent ?? Number(env("KERNEL_PROXY_KERNEL_TRAFFIC_PERCENT") ?? "0");
    const fallbackToArkerOnCreateError = envBoolean(
      "KERNEL_PROXY_FALLBACK_TO_ARKER_ON_CREATE_ERROR",
      hybrid.fallbackToArkerOnCreateError,
      true,
    );
    const fallbackToArkerOnNotFound = envBoolean(
      "KERNEL_PROXY_FALLBACK_TO_ARKER_ON_NOT_FOUND",
      hybrid.fallbackToArkerOnNotFound,
      kernelApiKey !== undefined,
    );
    const fallbackToArkerOnTransportError = envBoolean(
      "KERNEL_PROXY_FALLBACK_TO_ARKER_ON_TRANSPORT_ERROR",
      hybrid.fallbackToArkerOnTransportError,
      false,
    );
    const kernelRequestTimeoutMs = hybrid.kernelRequestTimeoutMs ?? Number(env("KERNEL_PROXY_KERNEL_TIMEOUT_MS") ?? "30000");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("KERNEL proxy port must be an integer between 0 and 65535");
    if (typeof host !== "string" || !host) throw new Error("Kernel proxy host is required");
    if (typeof sourceVmName !== "string" || !sourceVmName) throw new Error("Arker source VM name is required");
    if (options.sourceVmId !== undefined && (typeof options.sourceVmId !== "string" || !options.sourceVmId.trim())) {
      throw new Error("Arker source VM ID must be a non-empty string");
    }
    if (options.sourceLayers !== undefined && (
      !Array.isArray(options.sourceLayers)
      || !options.sourceLayers.includes("disk")
      || options.sourceLayers.some((layer) => layer !== "disk" && layer !== "memory")
    )) {
      throw new Error("Arker source layers must contain disk and may additionally contain memory");
    }
    if (sourcePlatforms.length === 0 || sourcePlatforms.some((platform) => typeof platform !== "string" || !platform.trim())) {
      throw new Error("At least one Arker source platform is required and every platform must be non-empty");
    }
    const normalizedSourcePlatforms = sourcePlatforms.map((platform) => platform.trim());
    if (!Number.isFinite(setupTimeoutSeconds) || setupTimeoutSeconds <= 0) throw new Error("Kernel proxy setup timeout must be positive");
    if (!Number.isInteger(setupMemoryMib) || setupMemoryMib < 128) throw new Error("Kernel proxy setup memory must be an integer of at least 128 MiB");
    if (runtimeMemoryMib !== undefined && (!Number.isInteger(runtimeMemoryMib) || runtimeMemoryMib < 128)) {
      throw new Error("Kernel proxy runtime memory must be an integer of at least 128 MiB");
    }
    if (runtimeVcpu !== undefined && (!Number.isFinite(runtimeVcpu) || runtimeVcpu <= 0)) {
      throw new Error("Kernel proxy runtime vCPU must be positive");
    }
    if (!Number.isInteger(createAttempts) || createAttempts < 1 || createAttempts > 5) {
      throw new Error("Kernel proxy create attempts must be an integer between 1 and 5");
    }
    if (!Number.isInteger(standbyDelayMs) || standbyDelayMs < 0 || standbyDelayMs > 60_000) {
      throw new Error("Kernel proxy standby delay must be an integer between 0 and 60000 ms");
    }
    if (!Number.isFinite(kernelTrafficPercent) || kernelTrafficPercent < 0 || kernelTrafficPercent > 100) {
      throw new Error("Kernel traffic percentage must be between 0 and 100");
    }
    if (!Number.isInteger(kernelRequestTimeoutMs) || kernelRequestTimeoutMs < 1 || kernelRequestTimeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`Kernel upstream timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
    }
    if ((kernelTrafficPercent > 0 || fallbackToArkerOnNotFound) && !kernelApiKey) {
      throw new Error("KERNEL_UPSTREAM_API_KEY is required when Kernel hybrid routing is enabled");
    }
    if (!signingSecret) throw new Error("Kernel proxy signing secret must not be empty");
    if (options.publicBaseUrl) {
      try {
        const protocol = new URL(options.publicBaseUrl).protocol;
        if (protocol !== "http:" && protocol !== "https:") throw new Error("unsupported protocol");
      } catch {
        throw new Error("Kernel proxy public URL must be a valid http or https URL");
      }
    }
    if (!apiKey && !isLoopback(host)) {
      throw new Error("KERNEL_PROXY_API_KEY is required when binding the Kernel proxy outside loopback");
    }
    if (!options.arker && !arkerApiKey) throw new Error("ARKER_API_KEY is required");

    this.options = { ...options, host, port, sourceVmName, sourcePlatforms: normalizedSourcePlatforms, setupTimeoutSeconds, setupMemoryMib, runtimeMemoryMib, runtimeVcpu, createAttempts, automaticStandby, standbyDelayMs, stateDirectory, arkerApiKey, arkerBaseUrl, apiKey };
    this.forwardApiKey = arkerApiKey;
    this.signingSecret = signingSecret;
    this.hybridRouting = {
      kernelApiKey,
      kernelBaseUrl,
      kernelTrafficPercent,
      fallbackToArkerOnCreateError,
      fallbackToArkerOnNotFound,
      fallbackToArkerOnTransportError,
      kernelRequestTimeoutMs,
    };
    this.arker = options.arker ?? new Arker({
      apiKey: arkerApiKey,
      baseUrl: arkerBaseUrl,
      controlBaseUrl: arkerBaseUrl,
    });
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      this.serverSockets.add(socket);
      socket.once("close", () => this.serverSockets.delete(socket));
    });
    this.server.on("upgrade", (req, socket, head) => void this.handleUpgrade(req, socket, head));
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    try {
      await this.loadBrowserRoutes();
    } catch (error) {
      await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
      throw error;
    }
    this.sweepTimer = setInterval(() => void this.sweepExpired(), 5_000);
    this.sweepTimer.unref?.();
    const address = this.server.address() as AddressInfo;
    return { host: this.options.host, port: address.port, url: this.publicBaseUrl() };
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // Pool fills call back into this HTTP server. Let any in-flight create see
    // the current registry state and perform its own orphan cleanup before
    // server.close() begins waiting for active connections to disappear.
    await Promise.all([...this.poolFillQueues.values()].map((fill) => fill.catch(() => undefined)));
    const sessionCleanup: Array<Promise<unknown>> = [];
    for (const process of this.interactiveProcesses.values()) {
      if (process.timeout) clearTimeout(process.timeout);
      process.connection.close(1001, "proxy shutting down");
      sessionCleanup.push(process.vm.deleteSession(process.connection.sessionId).catch(() => undefined));
      sessionCleanup.push(this.releaseInteractivePin(process).catch(() => undefined));
    }
    for (const process of this.detachedProcesses.values()) sessionCleanup.push(this.releaseDetachedSession(process));
    for (const watch of this.filesystemWatches.values()) sessionCleanup.push(this.stopWatchBackend(watch));
    for (const replay of this.browserReplays.values()) {
      if (replay.timer) clearInterval(replay.timer);
      if (replay.maxTimer) clearTimeout(replay.maxTimer);
      if (replay.audioPidPath) sessionCleanup.push(this.stopReplayAudio(replay).catch(() => undefined));
    }
    for (const socket of this.webSockets.clients) socket.terminate();
    for (const socket of this.upstreamWebSockets) socket.terminate();
    for (const response of this.streamingResponses) response.destroy();
    const closed = new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.server.closeIdleConnections?.();
    this.server.closeAllConnections?.();
    // Bun and older Node releases do not consistently close HTTP keep-alive
    // sockets through closeAllConnections(). Track and destroy them explicitly
    // so close() has a deterministic completion point after requests drain.
    for (const socket of this.serverSockets) socket.destroy();
    await Promise.all(sessionCleanup);
    await Promise.resolve();
    await Promise.all([...this.vmPinStateQueues.values()].map((pin) => pin.catch(() => undefined)));
    await this.flushScheduledStandby();
    await this.stateQueue.catch(() => undefined);
    // Bun can omit the HTTP server's close callback after upgraded WebSocket
    // connections even once every tracked socket is gone. The listening socket
    // is already closed synchronously by server.close(); bound only the callback
    // wait so embedded callers can restart the proxy deterministically.
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolveClose) => { closeTimer = setTimeout(resolveClose, 1_000); }),
      ]);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
  }

  /**
   * Build and keep awake a CloakBrowser source VM for low-latency disk+memory
   * forks. This is an explicit provisioning operation: the returned VM is
   * intentionally preserved until its owner deletes it.
   */
  async prepareSource(name = `arker-kernel-source-${randomUUID().slice(0, 12)}`): Promise<VM> {
    resourceName(name, "source name");
    const marker = `arker-kernel-source-v1:${randomUUID()}`;
    const policies = { policies: [{ type: "outbound" as const, action: "allow" as const }] };
    let source: VM | undefined;
    try {
      source = await this.arker.fork(this.options.sourceVmName, {
        name,
        description: marker,
        platforms: this.options.sourcePlatforms,
        policies,
      });
      await this.withVmPinned(source, async () => {
        await this.setupGuest(
          source!,
          { headless: true, stealth: true, timeout_seconds: 3_600 },
          { width: 1280, height: 720 },
          { extensions: [] },
        );
        if (this.options.runtimeMemoryMib !== undefined || this.options.runtimeVcpu !== undefined) {
          await source!.update({
            resources: {
              memory_mib: this.options.runtimeMemoryMib ?? null,
              vcpu: this.options.runtimeVcpu ?? null,
              disk_mib: null,
            },
          });
        }
      });
      // Session standby is the default, but a disk+memory source is useful only
      // while its prepared memory layer stays awake. Cancel the coalesced
      // release scheduled by withVmPinned and leave this explicitly provisioned
      // source pinned until its owner deletes it.
      const scheduled = this.vmStandbyTimers.get(source.id);
      if (scheduled) {
        clearTimeout(scheduled.timer);
        this.vmStandbyTimers.delete(source.id);
      }
      await source.run("curl -fsS --max-time 5 http://127.0.0.1:9222/json/version >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:9230/health >/dev/null", {
        timeout: 20,
        session_idx: SERVICE_SESSION_INDEX,
        keep_alive: true,
        idempotencyKey: randomUUID(),
      });
      return await source.refresh();
    } catch (error) {
      if (source) {
        const scheduled = this.vmStandbyTimers.get(source.id);
        if (scheduled) {
          clearTimeout(scheduled.timer);
          this.vmStandbyTimers.delete(source.id);
        }
      }
      await source?.delete().catch(() => undefined);
      throw error;
    }
  }

  private publicBaseUrl(req?: IncomingMessage): string {
    if (this.options.publicBaseUrl) return this.options.publicBaseUrl.replace(/\/+$/, "");
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    const host = req?.headers.host || `${this.options.host}:${port}`;
    const proto = String(req?.headers["x-forwarded-proto"] || "http").split(",", 1)[0]!.trim();
    return `${proto}://${host}`;
  }

  private token(kind: CapabilityKind, id: string): string {
    return createHmac("sha256", this.signingSecret).update(`${kind}:${id}`).digest("base64url");
  }

  private validToken(kind: CapabilityKind, id: string, token: string | null | undefined): boolean {
    return typeof token === "string" && safeEqual(token, this.token(kind, id));
  }

  private authenticate(req: IncomingMessage): void {
    const expected = this.options.apiKey;
    if (!expected) return;
    const header = String(req.headers.authorization || "");
    const actual = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(actual, expected)) throw new KernelHttpError(401, "invalid_api_key", "Invalid API key");
  }

  private trackStreamingResponse(res: ServerResponse): void {
    this.streamingResponses.add(res);
    const remove = () => this.streamingResponses.delete(res);
    res.once("close", remove);
    res.once("finish", remove);
  }

  private cacheRecord(record: BrowserRecord): void {
    for (const [key, cached] of this.cache) {
      if (cached.vm.id === record.vm.id && key !== record.vm.id && key !== record.metadata.name) this.cache.delete(key);
    }
    this.cache.set(record.vm.id, record);
    if (record.metadata.name) this.cache.set(record.metadata.name, record);
  }

  private forgetRecord(record: BrowserRecord): void {
    for (const [key, cached] of this.cache) if (cached.vm.id === record.vm.id) this.cache.delete(key);
    void this.forgetBrowserProvider(record.vm.id);
    this.knownAwakeVms.delete(record.vm.id);
    this.vmPinCounts.delete(record.vm.id);
    const scheduled = this.vmStandbyTimers.get(record.vm.id);
    if (scheduled) clearTimeout(scheduled.timer);
    this.vmStandbyTimers.delete(record.vm.id);
  }

  private async ensureUniqueName(name: string, excludeVmId?: string): Promise<void> {
    if (this.reservedNames.has(name)) throw new KernelHttpError(409, "name_conflict", `Browser name ${name} is already in use`);
    const vms = await this.listAllVms();
    if (this.reservedNames.has(name)) throw new KernelHttpError(409, "name_conflict", `Browser name ${name} is already in use`);
    for (const vm of vms) {
      if (vm.id === excludeVmId) continue;
      const description = (vm as unknown as { description?: unknown }).description;
      if (typeof description !== "string" || !description.startsWith(METADATA_PREFIX)) continue;
      if ((await this.metadataForVm(vm))?.name === name) {
        throw new KernelHttpError(409, "name_conflict", `Browser name ${name} is already in use`);
      }
    }
  }

  private emptyState(): KernelProxyState {
    return { version: STATE_VERSION, profiles: [], extensions: [], proxies: [], browserPools: [], browserRoutes: [] };
  }

  private async readState(): Promise<KernelProxyState> {
    try {
      const parsed = JSON.parse(await readFile(join(this.options.stateDirectory, "registry.json"), "utf8")) as Partial<KernelProxyState>;
      if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.profiles) || !Array.isArray(parsed.extensions)
        || !Array.isArray(parsed.proxies) || !Array.isArray(parsed.browserPools)
        || (parsed.browserRoutes !== undefined && !Array.isArray(parsed.browserRoutes))) {
        throw new KernelHttpError(500, "state_corrupt", "Kernel proxy state registry has an unsupported or invalid shape");
      }
      return { ...parsed, browserRoutes: parsed.browserRoutes ?? [] } as KernelProxyState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.emptyState();
      if (error instanceof KernelHttpError) throw error;
      throw new KernelHttpError(500, "state_corrupt", "Kernel proxy state registry is not valid JSON");
    }
  }

  private async writeState(state: KernelProxyState): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.stateDirectory, `.registry-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, join(this.options.stateDirectory, "registry.json"));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async withState<T>(operation: (state: KernelProxyState) => Promise<T> | T, write = false): Promise<T> {
    const previous = this.stateQueue;
    let release!: () => void;
    this.stateQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous.catch(() => undefined);
    try {
      const state = await this.readState();
      const result = await operation(state);
      if (write) await this.writeState(state);
      return result;
    } finally {
      release();
    }
  }

  private async loadBrowserRoutes(): Promise<void> {
    const routes = await this.withState((state) => state.browserRoutes);
    this.browserProviders.clear();
    this.browserRouteNames.clear();
    for (const route of routes) {
      if (!route || typeof route.sessionId !== "string" || !route.sessionId
        || (route.provider !== "arker" && route.provider !== "kernel")) continue;
      this.browserProviders.set(route.sessionId, route.provider);
      if (typeof route.name === "string" && route.name) {
        this.browserProviders.set(route.name, route.provider);
        this.browserRouteNames.set(route.sessionId, route.name);
      }
    }
  }

  private async rememberBrowserProvider(sessionId: string, provider: BrowserProvider, name?: string): Promise<void> {
    this.browserProviders.set(sessionId, provider);
    const previousName = this.browserRouteNames.get(sessionId);
    if (previousName && previousName !== name) this.browserProviders.delete(previousName);
    if (name) {
      this.browserProviders.set(name, provider);
      this.browserRouteNames.set(sessionId, name);
    } else {
      this.browserRouteNames.delete(sessionId);
    }
    try {
      await this.withState((state) => {
        state.browserRoutes = state.browserRoutes.filter((route) =>
          route.sessionId !== sessionId && route.name !== sessionId
          && (!name || (route.sessionId !== name && route.name !== name)));
        state.browserRoutes.push({ sessionId, ...(name ? { name } : {}), provider, updatedAt: isoNow() });
      }, true);
    } catch (error) {
      this.debugTiming("hybrid-route.persist-error", performance.now(), {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async forgetBrowserProvider(reference: string): Promise<void> {
    let sessionId = reference;
    for (const [candidate, name] of this.browserRouteNames) {
      if (name === reference) {
        sessionId = candidate;
        break;
      }
    }
    const name = this.browserRouteNames.get(sessionId);
    this.browserProviders.delete(reference);
    this.browserProviders.delete(sessionId);
    if (name) this.browserProviders.delete(name);
    this.browserRouteNames.delete(sessionId);
    try {
      await this.withState((state) => {
        state.browserRoutes = state.browserRoutes.filter((route) =>
          route.sessionId !== reference && route.name !== reference
          && route.sessionId !== sessionId && route.name !== name);
      }, true);
    } catch (error) {
      this.debugTiming("hybrid-route.delete-error", performance.now(), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private extensionPath(id: string): string {
    return join(this.options.stateDirectory, "extensions", `${id}.zip`);
  }

  private profilePath(id: string): string {
    return join(this.options.stateDirectory, "profiles", `${id}.tar`);
  }

  private findProfile(state: KernelProxyState, idOrName: string): StoredProfile {
    const normalized = idOrName.toLocaleLowerCase();
    const profile = state.profiles.find((item) => item.id === idOrName || item.name?.toLocaleLowerCase() === normalized);
    if (!profile) throw new KernelHttpError(404, "not_found", `Profile ${idOrName} not found`);
    return profile;
  }

  private findExtension(state: KernelProxyState, idOrName: string): StoredExtension {
    const normalized = idOrName.toLocaleLowerCase();
    const extension = state.extensions.find((item) => item.id === idOrName || item.name?.toLocaleLowerCase() === normalized);
    if (!extension) throw new KernelHttpError(404, "not_found", `Extension ${idOrName} not found`);
    return extension;
  }

  private findProxy(state: KernelProxyState, id: string): StoredProxy {
    const proxy = state.proxies.find((item) => item.id === id);
    if (!proxy) throw new KernelHttpError(404, "not_found", `Proxy ${id} not found`);
    return proxy;
  }

  private findPool(state: KernelProxyState, idOrName: string): StoredBrowserPool {
    const normalized = idOrName.toLocaleLowerCase();
    const pool = state.browserPools.find((item) => item.id === idOrName || item.name?.toLocaleLowerCase() === normalized);
    if (!pool) throw new KernelHttpError(404, "not_found", `Browser pool ${idOrName} not found`);
    return pool;
  }

  private profileResponse(profile: StoredProfile): Record<string, unknown> {
    return {
      id: profile.id,
      created_at: profile.createdAt,
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.updatedAt ? { updated_at: profile.updatedAt } : {}),
      ...(profile.lastUsedAt ? { last_used_at: profile.lastUsedAt } : {}),
    };
  }

  private extensionResponse(extension: StoredExtension): Record<string, unknown> {
    return {
      id: extension.id,
      created_at: extension.createdAt,
      size_bytes: extension.sizeBytes,
      checksum: extension.checksum,
      last_used_at: extension.lastUsedAt ?? null,
      ...(extension.name ? { name: extension.name } : {}),
    };
  }

  private proxyResponse(proxy: StoredProxy): Record<string, unknown> {
    return {
      id: proxy.id,
      type: proxy.type,
      protocol: proxy.protocol,
      bypass_hosts: proxy.bypassHosts,
      ...(proxy.name ? { name: proxy.name } : {}),
      ...(proxy.status ? { status: proxy.status } : {}),
      ...(proxy.lastChecked ? { last_checked: proxy.lastChecked } : {}),
      ...(proxy.ipAddress ? { ip_address: proxy.ipAddress } : {}),
      config: {
        host: proxy.config.host,
        port: proxy.config.port,
        ...(proxy.config.username ? { username: proxy.config.username } : {}),
        has_password: Boolean(proxy.config.password),
        has_ca_bundle: Boolean(proxy.config.caBundle),
      },
    };
  }

  private sendPage(res: ServerResponse, values: unknown[], url: URL): void {
    const limitValue = Number(url.searchParams.get("limit") ?? 20);
    const offsetValue = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isInteger(limitValue) || limitValue <= 0 || !Number.isInteger(offsetValue) || offsetValue < 0) {
      throw new KernelHttpError(422, "validation_error", "limit must be positive and offset must be non-negative integers");
    }
    const limit = Math.min(limitValue, 100);
    const page = values.slice(offsetValue, offsetValue + limit);
    const nextOffset = offsetValue + page.length < values.length ? offsetValue + page.length : 0;
    res.setHeader("x-has-more", nextOffset > 0 ? "true" : "false");
    res.setHeader("x-next-offset", String(nextOffset));
    sendJson(res, 200, page);
  }

  private async createProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const name = body.name === undefined ? undefined : resourceName(body.name);
    const profile = await this.withState(async (state) => {
      if (name && state.profiles.some((item) => item.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new KernelHttpError(409, "name_conflict", `Profile name ${name} is already in use`);
      }
      const created: StoredProfile = { id: `prof_${randomUUID().replace(/-/g, "")}`, ...(name ? { name } : {}), createdAt: isoNow(), hasArchive: false };
      state.profiles.push(created);
      return created;
    }, true);
    sendJson(res, 200, this.profileResponse(profile));
  }

  private async retrieveProfile(res: ServerResponse, idOrName: string): Promise<void> {
    const profile = await this.withState((state) => this.findProfile(state, idOrName));
    sendJson(res, 200, this.profileResponse(profile));
  }

  private async listProfiles(res: ServerResponse, url: URL): Promise<void> {
    const name = url.searchParams.get("name")?.toLocaleLowerCase();
    const query = url.searchParams.get("query")?.toLocaleLowerCase();
    const profiles = await this.withState((state) => state.profiles
      .filter((item) => !name || item.name?.toLocaleLowerCase() === name)
      .filter((item) => !query || `${item.id} ${item.name || ""}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => this.profileResponse(item)));
    this.sendPage(res, profiles, url);
  }

  private async updateProfile(req: IncomingMessage, res: ServerResponse, idOrName: string): Promise<void> {
    const body = await readJson(req);
    const name = resourceName(body.name);
    const profile = await this.withState((state) => {
      const current = this.findProfile(state, idOrName);
      if (state.profiles.some((item) => item.id !== current.id && item.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new KernelHttpError(409, "name_conflict", `Profile name ${name} is already in use`);
      }
      current.name = name;
      current.updatedAt = isoNow();
      return current;
    }, true);
    sendJson(res, 200, this.profileResponse(profile));
  }

  private async refreshIdlePoolsForProfile(profileId: string): Promise<void> {
    const poolIds = await this.withState((state) => state.browserPools
      .filter((pool) => pool.profileId === profileId && pool.config.refresh_on_profile_update === true)
      .map((pool) => pool.id));
    for (const poolId of poolIds) {
      await this.flushBrowserPoolSessions(poolId).catch(() => undefined);
      void this.fillBrowserPool(poolId).catch(() => undefined);
    }
  }

  private async deleteProfile(res: ServerResponse, idOrName: string): Promise<void> {
    const profile = await this.withState((state) => {
      const current = this.findProfile(state, idOrName);
      state.profiles = state.profiles.filter((item) => item.id !== current.id);
      for (const pool of state.browserPools) {
        if (pool.profileId === current.id) {
          pool.profileId = undefined;
          delete pool.config.profile;
          pool.config.refresh_on_profile_update = false;
        }
      }
      return current;
    }, true);
    await rm(this.profilePath(profile.id), { force: true }).catch(() => undefined);
    sendEmpty(res);
  }

  private async downloadProfile(res: ServerResponse, url: URL, idOrName: string): Promise<void> {
    const profile = await this.withState((state) => this.findProfile(state, idOrName));
    const format = url.searchParams.get("format") ?? "tar.zst";
    if (format !== "tar" && format !== "tar.zst") throw new KernelHttpError(422, "validation_error", "format must be tar or tar.zst");
    const archive = profile.hasArchive ? await readFile(this.profilePath(profile.id)).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new KernelHttpError(500, "state_corrupt", `Profile ${profile.id} archive is missing`);
      throw error;
    }) : EMPTY_PROFILE_ARCHIVE;
    sendBinary(res, 200, format === "tar" || !profile.hasArchive ? archive : zstdRawFrame(archive), "application/octet-stream");
  }

  private async uploadExtension(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.multipart(req);
    const file = form.get("file");
    const rawName = form.get("name");
    if (typeof file === "string" || file == null) throw new KernelHttpError(422, "validation_error", "file is required");
    if (rawName !== null && typeof rawName !== "string") throw new KernelHttpError(422, "validation_error", "name must be a string");
    const name = typeof rawName === "string" && rawName ? resourceName(rawName) : undefined;
    const archive = Buffer.from(await file.arrayBuffer());
    if (!isZipArchive(archive)) throw new KernelHttpError(422, "validation_error", "file must be a ZIP archive");
    const extension = await this.withState(async (state) => {
      if (name && state.extensions.some((item) => item.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new KernelHttpError(409, "name_conflict", `Extension name ${name} is already in use`);
      }
      const created: StoredExtension = {
        id: `ext_${randomUUID().replace(/-/g, "")}`,
        ...(name ? { name } : {}),
        createdAt: isoNow(),
        sizeBytes: archive.length,
        checksum: createHash("sha256").update(archive).digest("hex"),
      };
      await mkdir(join(this.options.stateDirectory, "extensions"), { recursive: true, mode: 0o700 });
      const temporary = `${this.extensionPath(created.id)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, archive, { mode: 0o600 });
        await rename(temporary, this.extensionPath(created.id));
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      state.extensions.push(created);
      return created;
    }, true);
    sendJson(res, 200, this.extensionResponse(extension));
  }

  private async retrieveExtension(res: ServerResponse, idOrName: string): Promise<void> {
    const extension = await this.withState((state) => this.findExtension(state, idOrName));
    sendJson(res, 200, this.extensionResponse(extension));
  }

  private async listExtensions(res: ServerResponse, url: URL): Promise<void> {
    const name = url.searchParams.get("name")?.toLocaleLowerCase();
    const query = url.searchParams.get("query")?.toLocaleLowerCase();
    const extensions = await this.withState((state) => state.extensions
      .filter((item) => !name || item.name?.toLocaleLowerCase() === name)
      .filter((item) => !query || `${item.id} ${item.name || ""}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => this.extensionResponse(item)));
    this.sendPage(res, extensions, url);
  }

  private async downloadExtension(res: ServerResponse, idOrName: string): Promise<void> {
    const extension = await this.withState((state) => this.findExtension(state, idOrName));
    const archive = await readFile(this.extensionPath(extension.id)).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new KernelHttpError(500, "state_corrupt", `Extension ${extension.id} archive is missing`);
      throw error;
    });
    sendBinary(res, 200, archive, "application/zip");
  }

  private async deleteExtension(res: ServerResponse, idOrName: string): Promise<void> {
    const extension = await this.withState((state) => {
      const current = this.findExtension(state, idOrName);
      state.extensions = state.extensions.filter((item) => item.id !== current.id);
      for (const pool of state.browserPools) {
        const configured = Array.isArray(pool.config.extensions) ? pool.config.extensions : [];
        const keptIndexes = pool.extensionIds.map((id, index) => id === current.id ? -1 : index).filter((index) => index >= 0);
        pool.extensionIds = keptIndexes.map((index) => pool.extensionIds[index]!);
        pool.config.extensions = keptIndexes.map((index) => configured[index]).filter((item) => item !== undefined);
      }
      return current;
    }, true);
    await rm(this.extensionPath(extension.id), { force: true }).catch(() => undefined);
    sendEmpty(res);
  }

  private async downloadChromeStoreExtension(res: ServerResponse, url: URL): Promise<void> {
    const source = url.searchParams.get("url");
    const os = url.searchParams.get("os") ?? "linux";
    if (!source) throw new KernelHttpError(422, "validation_error", "url is required");
    if (!(["win", "mac", "linux"] as string[]).includes(os)) throw new KernelHttpError(422, "validation_error", "os must be win, mac, or linux");
    let parsed: URL;
    try { parsed = new URL(source); } catch { throw new KernelHttpError(422, "validation_error", "url must be a valid Chrome Web Store URL"); }
    if (!/^(?:chromewebstore\.google\.com|chrome\.google\.com)$/i.test(parsed.hostname)) {
      throw new KernelHttpError(422, "validation_error", "url must reference the Chrome Web Store");
    }
    const extensionId = parsed.pathname.match(/\/([a-p]{32})(?:\/|$)/i)?.[1]?.toLowerCase();
    if (!extensionId) throw new KernelHttpError(422, "validation_error", "url does not contain a Chrome extension ID");
    const update = new URL("https://clients2.google.com/service/update2/crx");
    update.searchParams.set("response", "redirect");
    update.searchParams.set("prodversion", "146.0.0.0");
    update.searchParams.set("acceptformat", "crx2,crx3");
    update.searchParams.set("x", `id=${extensionId}&uc`);
    update.searchParams.set("os", os);
    const response = await fetch(update, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "Mozilla/5.0 Chrome/146.0.0.0" } });
    if (!response.ok) throw new KernelHttpError(502, "extension_download_failed", `Chrome Web Store returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_BODY_BYTES) throw new KernelHttpError(413, "payload_too_large", `extension archive exceeds ${MAX_BODY_BYTES} bytes`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BODY_BYTES) throw new KernelHttpError(413, "payload_too_large", `extension archive exceeds ${MAX_BODY_BYTES} bytes`);
    sendBinary(res, 200, crxZipPayload(body), "application/zip");
  }

  private async createProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (body.type !== "custom") {
      if (!["datacenter", "isp", "residential", "mobile"].includes(String(body.type))) throw new KernelHttpError(422, "validation_error", "type must be datacenter, isp, residential, mobile, or custom");
      throw new KernelHttpError(422, "unsupported_operation", `Managed ${body.type} proxy capacity is a Kernel provider service; configure a custom proxy for the Arker shim`);
    }
    const protocol = body.protocol === undefined ? "http" : body.protocol;
    if (protocol !== "http" && protocol !== "https") throw new KernelHttpError(422, "validation_error", "protocol must be http or https");
    const config = asObject(body.config);
    if (typeof config.host !== "string" || !config.host.trim() || /[\s\0/]/.test(config.host)) throw new KernelHttpError(422, "validation_error", "config.host must be a valid hostname or IP");
    if (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65_535) throw new KernelHttpError(422, "validation_error", "config.port must be an integer between 1 and 65535");
    for (const field of ["username", "password", "ca_bundle"] as const) {
      if (config[field] !== undefined && typeof config[field] !== "string") throw new KernelHttpError(422, "validation_error", `config.${field} must be a string`);
    }
    if (body.bypass_hosts !== undefined && (!Array.isArray(body.bypass_hosts) || body.bypass_hosts.some((item) => typeof item !== "string" || !item))) {
      throw new KernelHttpError(422, "validation_error", "bypass_hosts must be an array of non-empty strings");
    }
    const name = body.name === undefined ? undefined : String(body.name).trim();
    if (body.name !== undefined && (!name || name.length > 255)) throw new KernelHttpError(422, "validation_error", "name must contain 1-255 characters");
    const proxy = await this.withState((state) => {
      const created: StoredProxy = {
        id: `proxy_${randomUUID().replace(/-/g, "")}`,
        type: "custom",
        ...(name ? { name } : {}),
        protocol,
        bypassHosts: Array.isArray(body.bypass_hosts) ? [...body.bypass_hosts] as string[] : [],
        config: {
          host: config.host as string,
          port: config.port as number,
          ...(config.username === undefined ? {} : { username: config.username as string }),
          ...(config.password === undefined ? {} : { password: config.password as string }),
          ...(config.ca_bundle === undefined ? {} : { caBundle: config.ca_bundle as string }),
        },
      };
      state.proxies.push(created);
      return created;
    }, true);
    sendJson(res, 200, this.proxyResponse(proxy));
  }

  private async retrieveProxy(res: ServerResponse, id: string): Promise<void> {
    const proxy = await this.withState((state) => this.findProxy(state, id));
    sendJson(res, 200, this.proxyResponse(proxy));
  }

  private async listProxies(res: ServerResponse, url: URL): Promise<void> {
    const name = url.searchParams.get("name")?.toLocaleLowerCase();
    const query = url.searchParams.get("query")?.toLocaleLowerCase();
    const proxies = await this.withState((state) => state.proxies
      .filter((item) => !name || item.name?.toLocaleLowerCase() === name)
      .filter((item) => !query || `${item.id} ${item.name || ""} ${item.config.host}`.toLocaleLowerCase().includes(query))
      .map((item) => this.proxyResponse(item)));
    this.sendPage(res, proxies, url);
  }

  private async updateProxy(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 255) throw new KernelHttpError(422, "validation_error", "name must contain 1-255 characters");
    const proxy = await this.withState((state) => {
      const current = this.findProxy(state, id);
      current.name = name;
      return current;
    }, true);
    sendJson(res, 200, this.proxyResponse(proxy));
  }

  private async deleteProxy(res: ServerResponse, id: string): Promise<void> {
    await this.withState((state) => {
      this.findProxy(state, id);
      state.proxies = state.proxies.filter((item) => item.id !== id);
      for (const pool of state.browserPools) if (pool.config.proxy_id === id) delete pool.config.proxy_id;
    }, true);
    sendEmpty(res);
  }

  private async checkProxy(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = asObject(await readJson(req));
    const targeted = body.url !== undefined;
    let target: URL;
    try { target = new URL(targeted ? String(body.url) : "https://api.ipify.org/"); }
    catch { throw new KernelHttpError(422, "validation_error", "url must be a valid HTTP or HTTPS URL"); }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new KernelHttpError(422, "validation_error", "url must use HTTP or HTTPS");
    if (targeted) await requirePublicProxyCheckTarget(target);
    const proxy = await this.withState((state) => this.findProxy(state, id));
    const available = await checkCustomProxy(proxy, target).catch(() => false);
    // Kernel treats an explicit target as a one-off reachability probe. It
    // returns that probe's result without overwriting the proxy's general
    // health state because a site-specific failure need not mean the proxy is
    // unhealthy.
    if (targeted) {
      sendJson(res, 200, { ...this.proxyResponse(proxy), status: available ? "available" : "unavailable" });
      return;
    }
    const updated = await this.withState((state) => {
      const current = this.findProxy(state, id);
      current.status = available ? "available" : "unavailable";
      current.lastChecked = isoNow();
      return current;
    }, true);
    sendJson(res, 200, this.proxyResponse(updated));
  }

  private async resolveBrowserAssociations(body: KernelBrowserCreate): Promise<BrowserAssociations> {
    let profileSelector: { id?: string; name?: string } | undefined;
    let saveChanges = false;
    if (body.profile != null) {
      const profileBody = asObject(body.profile);
      profileSelector = selector(profileBody, "profile");
      if (profileBody.save_changes !== undefined && typeof profileBody.save_changes !== "boolean") {
        throw new KernelHttpError(422, "validation_error", "profile.save_changes must be a boolean");
      }
      saveChanges = profileBody.save_changes === true;
    }
    if (body.extensions !== undefined && !Array.isArray(body.extensions)) {
      throw new KernelHttpError(422, "validation_error", "extensions must be an array");
    }
    const extensionSelectors = (body.extensions ?? []).map((item, index) => selector(item, `extensions[${index}]`));
    if (body.proxy_id !== undefined && (typeof body.proxy_id !== "string" || !body.proxy_id)) {
      throw new KernelHttpError(422, "validation_error", "proxy_id must be a non-empty string");
    }
    const selected = await this.withState((state) => {
      const profile = profileSelector
        ? this.findProfile(state, profileSelector.id ?? profileSelector.name!)
        : undefined;
      const extensions = extensionSelectors.map((item) => this.findExtension(state, item.id ?? item.name!));
      const duplicate = extensions.find((item, index) => extensions.findIndex((other) => other.id === item.id) !== index);
      if (duplicate) throw new KernelHttpError(422, "validation_error", `Extension ${duplicate.id} was selected more than once`);
      const proxy = body.proxy_id ? this.findProxy(state, body.proxy_id) : undefined;
      return { profile, extensions, proxy };
    });
    const profileArchive = selected.profile?.hasArchive
      ? await readFile(this.profilePath(selected.profile.id)).catch((error) => {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new KernelHttpError(500, "state_corrupt", `Profile ${selected.profile!.id} archive is missing`);
        throw error;
      })
      : undefined;
    const extensions = await Promise.all(selected.extensions.map(async (record) => ({
      record,
      archive: await readFile(this.extensionPath(record.id)).catch((error) => {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new KernelHttpError(500, "state_corrupt", `Extension ${record.id} archive is missing`);
        throw error;
      }),
    })));
    return {
      ...(selected.profile ? { profile: { record: selected.profile, ...(profileArchive ? { archive: profileArchive } : {}), saveChanges } } : {}),
      extensions,
      ...(selected.proxy ? { proxy: selected.proxy } : {}),
    };
  }

  private async touchBrowserAssociations(associations: BrowserAssociations): Promise<void> {
    if (!associations.profile && associations.extensions.length === 0) return;
    const usedAt = isoNow();
    await this.withState((state) => {
      if (associations.profile) this.findProfile(state, associations.profile.record.id).lastUsedAt = usedAt;
      for (const extension of associations.extensions) this.findExtension(state, extension.record.id).lastUsedAt = usedAt;
    }, true);
  }

  private poolResponse(pool: StoredBrowserPool): Record<string, unknown> {
    return {
      id: pool.id,
      name: pool.name,
      created_at: pool.createdAt,
      acquired_count: pool.leasedSessionIds.length,
      available_count: pool.idleSessionIds.length,
      browser_pool_config: pool.config,
      extension_ids: pool.extensionIds,
      ...(pool.profileId ? { profile_id: pool.profileId } : {}),
    };
  }

  private async normalizePoolConfig(
    input: Record<string, unknown>,
    existing?: StoredBrowserPool,
  ): Promise<{ config: StoredBrowserPool["config"]; extensionIds: string[]; profileId?: string; name?: string }> {
    const allowed = new Set([
      "size", "chrome_policy", "extensions", "fill_rate_per_minute", "headless", "kiosk_mode", "name", "profile",
      "proxy_id", "refresh_on_profile_update", "start_url", "stealth", "telemetry", "timeout_seconds", "viewport",
      "discard_all_idle",
    ]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown) throw new KernelHttpError(422, "validation_error", `unknown browser pool field ${unknown}`);
    const merged: Record<string, unknown> = { ...(existing?.config ?? {}), ...input };
    delete merged.discard_all_idle;
    if (input.name === "") {
      if (existing?.name) merged.name = existing.name;
      else delete merged.name;
    }
    const size = merged.size;
    if (!Number.isInteger(size) || Number(size) < 1 || Number(size) > 1_000) {
      throw new KernelHttpError(422, "validation_error", "size must be an integer between 1 and 1000");
    }
    const name = merged.name === undefined ? undefined : resourceName(merged.name);
    const fillRate = merged.fill_rate_per_minute ?? 25;
    if (typeof fillRate !== "number" || !Number.isFinite(fillRate) || fillRate <= 0) {
      throw new KernelHttpError(422, "validation_error", "fill_rate_per_minute must be positive");
    }
    for (const field of ["headless", "kiosk_mode", "stealth", "refresh_on_profile_update"] as const) {
      if (merged[field] !== undefined && typeof merged[field] !== "boolean") {
        throw new KernelHttpError(422, "validation_error", `${field} must be a boolean`);
      }
    }
    const timeoutSeconds = merged.timeout_seconds ?? 600;
    if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 10 || Number(timeoutSeconds) > MAX_TIMEOUT_SECONDS) {
      throw new KernelHttpError(422, "validation_error", `timeout_seconds must be between 10 and ${MAX_TIMEOUT_SECONDS}`);
    }
    if (merged.start_url !== undefined && typeof merged.start_url !== "string") {
      throw new KernelHttpError(422, "validation_error", "start_url must be a string");
    }
    const chromePolicy = merged.chrome_policy === undefined ? undefined : parseChromePolicy(merged.chrome_policy);
    let viewport: Record<string, unknown> | undefined;
    if (merged.viewport !== undefined) {
      const value = asObject(merged.viewport);
      if (!Number.isInteger(value.width) || Number(value.width) <= 0 || !Number.isInteger(value.height) || Number(value.height) <= 0
        || (value.refresh_rate !== undefined && (!Number.isInteger(value.refresh_rate) || Number(value.refresh_rate) <= 0))) {
        throw new KernelHttpError(422, "validation_error", "viewport width, height, and optional refresh_rate must be positive integers");
      }
      viewport = value;
    }
    const telemetry = existing
      ? telemetryOnUpdate(existing.config.telemetry, input.telemetry)
      : telemetryOnCreate(merged.telemetry);
    const configuredTelemetry = telemetry && typeof telemetry === "object" && !Array.isArray(telemetry)
      && (telemetry as { browser?: unknown }).browser
      ? telemetry
      : undefined;
    const profileValue = merged.profile;
    const profileCleared = profileValue === null || (profileValue && typeof profileValue === "object" && !Array.isArray(profileValue)
      && ((profileValue as Record<string, unknown>).id === "" || (profileValue as Record<string, unknown>).name === ""));
    if (profileCleared && input.refresh_on_profile_update === true) {
      throw new KernelHttpError(422, "validation_error", "refresh_on_profile_update=true requires a profile");
    }
    if (profileCleared) merged.refresh_on_profile_update = false;
    const proxyCleared = merged.proxy_id === "" || merged.proxy_id === null;
    const associations = await this.resolveBrowserAssociations({
      ...(profileValue !== undefined && !profileCleared ? { profile: profileValue } : {}),
      ...(merged.extensions !== undefined ? { extensions: merged.extensions as unknown[] } : {}),
      ...(merged.proxy_id !== undefined && !proxyCleared ? { proxy_id: merged.proxy_id as string } : {}),
    });
    const nextProfileId = associations.profile?.record.id;
    if (merged.refresh_on_profile_update === true && !nextProfileId) {
      throw new KernelHttpError(422, "validation_error", "refresh_on_profile_update=true requires a profile");
    }
    const refreshOnProfileUpdate = !nextProfileId
      ? false
      : input.refresh_on_profile_update !== undefined
        ? input.refresh_on_profile_update
        : !existing || existing.profileId !== nextProfileId
          ? true
          : existing.config.refresh_on_profile_update ?? true;
    const config: StoredBrowserPool["config"] = {
      size: Number(size),
      fill_rate_per_minute: fillRate,
      headless: merged.headless ?? false,
      kiosk_mode: merged.kiosk_mode ?? false,
      stealth: merged.stealth ?? false,
      timeout_seconds: Number(timeoutSeconds),
      ...(name ? { name } : {}),
      ...(chromePolicy ? { chrome_policy: chromePolicy } : {}),
      ...(merged.extensions !== undefined ? { extensions: merged.extensions } : {}),
      ...(associations.profile ? { profile: { id: associations.profile.record.id } } : {}),
      ...(associations.proxy ? { proxy_id: associations.proxy.id } : {}),
      ...(nextProfileId ? { refresh_on_profile_update: refreshOnProfileUpdate } : {}),
      ...(merged.start_url !== undefined && merged.start_url !== "" ? { start_url: merged.start_url } : {}),
      ...(configuredTelemetry ? { telemetry: configuredTelemetry } : {}),
      ...(viewport ? { viewport } : {}),
    };
    return {
      config,
      extensionIds: associations.extensions.map((item) => item.record.id),
      ...(associations.profile ? { profileId: associations.profile.record.id } : {}),
      ...(name ? { name } : {}),
    };
  }

  private async createBrowserPool(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const normalized = await this.normalizePoolConfig(await readJson(req));
    const pool = await this.withState((state) => {
      if (normalized.name && state.browserPools.some((item) => item.name?.toLocaleLowerCase() === normalized.name!.toLocaleLowerCase())) {
        throw new KernelHttpError(409, "name_conflict", `Browser pool name ${normalized.name} is already in use`);
      }
      const created: StoredBrowserPool = {
        id: `pool_${randomUUID().replace(/-/g, "")}`,
        ...(normalized.name ? { name: normalized.name } : {}),
        createdAt: isoNow(),
        config: normalized.config,
        extensionIds: normalized.extensionIds,
        ...(normalized.profileId ? { profileId: normalized.profileId } : {}),
        idleSessionIds: [],
        leasedSessionIds: [],
      };
      state.browserPools.push(created);
      return created;
    }, true);
    void this.fillBrowserPool(pool.id).catch(() => undefined);
    sendJson(res, 200, this.poolResponse(pool));
  }

  private async retrieveBrowserPool(res: ServerResponse, idOrName: string): Promise<void> {
    const pool = await this.withState((state) => this.findPool(state, idOrName));
    sendJson(res, 200, this.poolResponse(pool));
  }

  private async listBrowserPools(res: ServerResponse, url: URL): Promise<void> {
    const name = url.searchParams.get("name")?.toLocaleLowerCase();
    const query = url.searchParams.get("query")?.toLocaleLowerCase();
    const pools = await this.withState((state) => state.browserPools
      .filter((item) => !name || item.name?.toLocaleLowerCase() === name)
      .filter((item) => !query || `${item.id} ${item.name || ""}`.toLocaleLowerCase().includes(query))
      .map((item) => this.poolResponse(item)));
    this.sendPage(res, pools, url);
  }

  private async updateBrowserPool(req: IncomingMessage, res: ServerResponse, idOrName: string): Promise<void> {
    const body = await readJson(req);
    const current = await this.withState((state) => this.findPool(state, idOrName));
    const normalized = await this.normalizePoolConfig(body, current);
    const discardIdle = body.discard_all_idle === true;
    if (body.discard_all_idle !== undefined && typeof body.discard_all_idle !== "boolean") {
      throw new KernelHttpError(422, "validation_error", "discard_all_idle must be a boolean");
    }
    const updated = await this.withState((state) => {
      const pool = this.findPool(state, current.id);
      if (normalized.name && state.browserPools.some((item) => item.id !== pool.id && item.name?.toLocaleLowerCase() === normalized.name!.toLocaleLowerCase())) {
        throw new KernelHttpError(409, "name_conflict", `Browser pool name ${normalized.name} is already in use`);
      }
      pool.name = normalized.name;
      pool.config = normalized.config;
      pool.extensionIds = normalized.extensionIds;
      pool.profileId = normalized.profileId;
      return pool;
    }, true);
    if (discardIdle || updated.idleSessionIds.length > updated.config.size) await this.flushBrowserPoolSessions(updated.id, discardIdle ? 0 : updated.config.size);
    void this.fillBrowserPool(updated.id).catch(() => undefined);
    sendJson(res, 200, this.poolResponse(await this.withState((state) => this.findPool(state, updated.id))));
  }

  private internalOrigin(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new KernelHttpError(500, "internal_error", "Kernel proxy is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  private async createIdlePoolBrowser(pool: StoredBrowserPool): Promise<string> {
    const body: Record<string, unknown> = { ...pool.config };
    delete body.size;
    delete body.name;
    delete body.fill_rate_per_minute;
    delete body.refresh_on_profile_update;
    if (body.profile && typeof body.profile === "object") body.profile = { ...(body.profile as Record<string, unknown>), save_changes: false };
    if (body.telemetry && typeof body.telemetry === "object" && !Array.isArray(body.telemetry)) {
      // Pool responses store Kernel's resolved telemetry shape, including the
      // read-only export block. Browser create accepts only enabled/browser.
      body.telemetry = { browser: (body.telemetry as { browser?: unknown }).browser };
    }
    const response = await fetch(`${this.internalOrigin()}/browsers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(60_000, (this.options.setupTimeoutSeconds + 300) * 1_000)),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new KernelHttpError(response.status, String(payload.error?.code || "pool_fill_failed"), String(payload.error?.message || `Pool browser creation failed with HTTP ${response.status}`));
    const record = await this.loadRecord(String(payload.session_id));
    record.metadata.name = undefined;
    record.metadata.tags = undefined;
    record.metadata.profileSaveChanges = false;
    record.metadata.pool = {
      id: pool.id,
      ...(pool.name ? { name: pool.name } : {}),
      state: "idle",
      baselineTelemetry: record.metadata.telemetry,
    };
    await this.persist(record);
    const kept = await this.withState((state) => {
      const current = state.browserPools.find((item) => item.id === pool.id);
      if (!current || current.idleSessionIds.length + current.leasedSessionIds.length >= current.config.size) return false;
      current.idleSessionIds.push(record.vm.id);
      return true;
    }, true);
    if (!kept) {
      await this.cleanupBrowserResources(record.vm.id).catch(() => undefined);
      await record.vm.delete().catch(() => undefined);
      this.forgetRecord(record);
    }
    return record.vm.id;
  }

  private async fillBrowserPool(id: string): Promise<void> {
    const previous = this.poolFillQueues.get(id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      while (true) {
        const pool = await this.withState((state) => state.browserPools.find((item) => item.id === id));
        if (!pool || pool.idleSessionIds.length + pool.leasedSessionIds.length >= pool.config.size) return;
        await this.createIdlePoolBrowser(pool);
        const delay = 60_000 / Number(pool.config.fill_rate_per_minute || 25);
        if (delay > 0 && pool.idleSessionIds.length + pool.leasedSessionIds.length + 1 < pool.config.size) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(delay, 60_000)));
        }
      }
    });
    const marker = task.then(() => undefined, () => undefined);
    this.poolFillQueues.set(id, marker);
    try { await task; }
    finally { if (this.poolFillQueues.get(id) === marker) this.poolFillQueues.delete(id); }
  }

  private async acquireBrowserPool(req: IncomingMessage, res: ServerResponse, idOrName: string): Promise<void> {
    const body = await readJson(req);
    if (body.acquire_timeout_seconds !== undefined && (typeof body.acquire_timeout_seconds !== "number" || !Number.isFinite(body.acquire_timeout_seconds) || body.acquire_timeout_seconds < 0)) {
      throw new KernelHttpError(422, "validation_error", "acquire_timeout_seconds must be non-negative");
    }
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name)) throw new KernelHttpError(422, "validation_error", "name must be a non-empty string");
    if (body.name) await this.ensureUniqueName(body.name as string);
    const pool = await this.withState((state) => this.findPool(state, idOrName));
    const timeoutMs = Number(body.acquire_timeout_seconds ?? Math.max(60, this.options.setupTimeoutSeconds + 300)) * 1_000;
    const fill = this.fillBrowserPool(pool.id);
    let acquireTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fill,
        new Promise((resolveTimeout) => { acquireTimer = setTimeout(resolveTimeout, timeoutMs); }),
      ]);
    } finally {
      if (acquireTimer) clearTimeout(acquireTimer);
    }
    const sessionId = await this.withState((state) => {
      const current = this.findPool(state, pool.id);
      const available = current.idleSessionIds.shift();
      if (available) current.leasedSessionIds.push(available);
      return available;
    }, true);
    if (!sessionId) return sendEmpty(res);
    try {
      const record = await this.loadRecord(sessionId);
      record.metadata.pool = {
        ...record.metadata.pool,
        id: pool.id,
        ...(pool.name ? { name: pool.name } : {}),
        state: "leased",
      };
      record.metadata.name = body.name as string | undefined;
      record.metadata.tags = body.tags === undefined ? undefined : parseTags(body.tags);
      if (body.telemetry !== undefined) {
        record.metadata.telemetry = telemetryOnUpdate(record.metadata.telemetry, body.telemetry);
        await this.updateGuestTelemetry(record, record.metadata.telemetry);
      }
      if (body.start_url !== undefined) {
        if (typeof body.start_url !== "string" || !body.start_url) throw new KernelHttpError(422, "validation_error", "start_url must be a non-empty string");
        record.metadata.startUrl = body.start_url;
        await this.executePlaywright(record, `await page.goto(${JSON.stringify(body.start_url)}, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); return true;`).catch(() => undefined);
      }
      await this.persist(record);
      sendJson(res, 200, this.browserResponse(req, record));
    } catch (error) {
      await this.withState((state) => {
        const current = state.browserPools.find((item) => item.id === pool.id);
        if (current) current.leasedSessionIds = current.leasedSessionIds.filter((item) => item !== sessionId);
      }, true);
      const record = await this.loadRecord(sessionId).catch(() => undefined);
      if (record) {
        await this.cleanupBrowserResources(record.vm.id).catch(() => undefined);
        await record.vm.delete().catch(() => undefined);
        this.forgetRecord(record);
      }
      void this.fillBrowserPool(pool.id).catch(() => undefined);
      throw error;
    }
  }

  private async releaseBrowserPool(req: IncomingMessage, res: ServerResponse, idOrName: string): Promise<void> {
    const body = await readJson(req);
    if (typeof body.session_id !== "string" || !body.session_id) throw new KernelHttpError(422, "validation_error", "session_id is required");
    if (body.reuse !== undefined && typeof body.reuse !== "boolean") throw new KernelHttpError(422, "validation_error", "reuse must be a boolean");
    const pool = await this.withState((state) => this.findPool(state, idOrName));
    if (!pool.leasedSessionIds.includes(body.session_id)) throw new KernelHttpError(404, "not_found", `Browser ${body.session_id} is not leased from pool ${pool.id}`);
    const record = await this.loadRecord(body.session_id);
    if (body.reuse === false) {
      await this.withState((state) => {
        const current = this.findPool(state, pool.id);
        current.leasedSessionIds = current.leasedSessionIds.filter((item) => item !== body.session_id);
      }, true);
      await this.cleanupBrowserResources(record.vm.id);
      await record.vm.delete();
      this.forgetRecord(record);
    } else {
      record.metadata.name = undefined;
      record.metadata.tags = undefined;
      record.metadata.startUrl = pool.config.start_url as string | undefined;
      record.metadata.telemetry = record.metadata.pool?.baselineTelemetry ?? pool.config.telemetry;
      record.metadata.pool = {
        ...record.metadata.pool,
        id: pool.id,
        ...(pool.name ? { name: pool.name } : {}),
        state: "idle",
        baselineTelemetry: record.metadata.telemetry,
      };
      if (!this.options.skipSetup) await this.updateGuestTelemetry(record, record.metadata.telemetry);
      await this.persist(record);
      await this.withState((state) => {
        const current = this.findPool(state, pool.id);
        current.leasedSessionIds = current.leasedSessionIds.filter((item) => item !== body.session_id);
        if (!current.idleSessionIds.includes(body.session_id as string)) current.idleSessionIds.push(body.session_id as string);
      }, true);
    }
    void this.fillBrowserPool(pool.id).catch(() => undefined);
    sendEmpty(res);
  }

  private async flushBrowserPoolSessions(id: string, keep = 0): Promise<void> {
    const sessionIds = await this.withState((state) => {
      const pool = this.findPool(state, id);
      const retained = pool.idleSessionIds.slice(0, keep);
      const removed = pool.idleSessionIds.slice(keep);
      pool.idleSessionIds = retained;
      return removed;
    }, true);
    for (const sessionId of sessionIds) {
      const record = await this.loadRecord(sessionId).catch(() => undefined);
      if (!record) continue;
      await this.cleanupBrowserResources(record.vm.id).catch(() => undefined);
      await record.vm.delete().catch(() => undefined);
      this.forgetRecord(record);
    }
  }

  private async flushBrowserPool(res: ServerResponse, idOrName: string): Promise<void> {
    const pool = await this.withState((state) => this.findPool(state, idOrName));
    await this.flushBrowserPoolSessions(pool.id);
    void this.fillBrowserPool(pool.id).catch(() => undefined);
    sendEmpty(res);
  }

  private async deleteBrowserPool(req: IncomingMessage, res: ServerResponse, idOrName: string): Promise<void> {
    const body = await readJson(req);
    if (body.force !== undefined && typeof body.force !== "boolean") throw new KernelHttpError(422, "validation_error", "force must be a boolean");
    const poolId = await this.withState((state) => this.findPool(state, idOrName).id);
    const sessionIds = await this.withState((state) => {
      const pool = this.findPool(state, idOrName);
      if (pool.leasedSessionIds.length && body.force !== true) throw new KernelHttpError(409, "pool_in_use", "Browser pool has leased browsers; use force=true to delete it");
      state.browserPools = state.browserPools.filter((item) => item.id !== pool.id);
      return [...pool.idleSessionIds, ...pool.leasedSessionIds];
    }, true);
    // Removing the registry entry is the cancellation signal for a fill that
    // has already begun. Await it so createIdlePoolBrowser can observe the
    // missing pool and delete the just-forked VM before DELETE returns.
    await this.poolFillQueues.get(poolId)?.catch(() => undefined);
    for (const sessionId of sessionIds) {
      const record = await this.loadRecord(sessionId).catch(() => undefined);
      if (!record) continue;
      await this.cleanupBrowserResources(record.vm.id).catch(() => undefined);
      await record.vm.delete().catch(() => undefined);
      this.forgetRecord(record);
    }
    sendEmpty(res);
  }

  private async cleanupBrowserResources(vmId: string): Promise<void> {
    for (const [processId, process] of this.interactiveProcesses) {
      if (process.vm.id !== vmId) continue;
      if (process.timeout) clearTimeout(process.timeout);
      process.connection.close(1001, "browser deleted");
      await process.vm.deleteSession(process.connection.sessionId).catch(() => undefined);
      await this.releaseInteractivePin(process).catch(() => undefined);
      this.interactiveProcesses.delete(processId);
    }
    for (const [processId, process] of this.detachedProcesses) {
      if (process.vm.id !== vmId) continue;
      await this.releaseDetachedSession(process);
      this.detachedProcesses.delete(processId);
    }
    for (const [watchId, watch] of this.filesystemWatches) {
      if (watch.vmId !== vmId) continue;
      await this.stopWatchBackend(watch);
      this.filesystemWatches.delete(watchId);
    }
    for (const [replayId, replay] of this.browserReplays) {
      if (replay.vm.id !== vmId) continue;
      if (replay.timer) clearInterval(replay.timer);
      if (replay.maxTimer) clearTimeout(replay.maxTimer);
      if (replay.audioPidPath) await this.stopReplayAudio(replay).catch(() => undefined);
      this.browserReplays.delete(replayId);
    }
  }

  private async fetchKernelUpstream(req: IncomingMessage, url: URL): Promise<KernelUpstreamResponse> {
    const kernelApiKey = this.hybridRouting.kernelApiKey;
    if (!kernelApiKey) throw new KernelHttpError(503, "kernel_upstream_unconfigured", "Kernel upstream routing is not configured");
    const headers = new Headers();
    const omitted = new Set([
      "authorization", "connection", "content-length", "host", "keep-alive",
      "proxy-authenticate", "proxy-authorization", "te", "trailer",
      "transfer-encoding", "upgrade", "x-api-key", "x-kernel-api-key",
    ]);
    for (const name of String(req.headers.connection || "").split(",")) {
      if (name.trim()) omitted.add(name.trim().toLowerCase());
    }
    for (const [name, rawValue] of Object.entries(req.headers)) {
      if (omitted.has(name.toLowerCase()) || rawValue === undefined) continue;
      if (Array.isArray(rawValue)) for (const value of rawValue) headers.append(name, value);
      else headers.set(name, rawValue);
    }
    headers.set("authorization", `Bearer ${kernelApiKey}`);
    // Node fetch transparently decompresses responses, so request identity
    // encoding and relay a self-consistent body/header pair.
    headers.set("accept-encoding", "identity");
    const body = ["GET", "HEAD"].includes(req.method || "GET") ? undefined : await readBody(req);
    const upstreamUrl = new URL(`${url.pathname.replace(/^\//, "")}${url.search}`, `${this.hybridRouting.kernelBaseUrl}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.hybridRouting.kernelRequestTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(upstreamUrl, {
        method: req.method || "GET",
        headers,
        body: body && body.length > 0 ? body as unknown as BodyInit : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      return {
        response,
        cancelTimeout: () => clearTimeout(timer),
        timedOut: () => controller.signal.aborted,
      };
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new KernelHttpError(504, "kernel_upstream_timeout", `Kernel upstream exceeded ${this.hybridRouting.kernelRequestTimeoutMs} ms`);
      }
      throw new KernelHttpError(502, "kernel_upstream_unavailable", error instanceof Error ? error.message : "Kernel upstream request failed");
    }
  }

  private async discardKernelResponse(upstream: KernelUpstreamResponse): Promise<void> {
    upstream.cancelTimeout();
    await upstream.response.body?.cancel().catch(() => undefined);
  }

  private async readKernelResponseBody(upstream: KernelUpstreamResponse): Promise<Buffer> {
    try {
      return Buffer.from(await upstream.response.arrayBuffer());
    } catch (error) {
      if (upstream.timedOut()) {
        throw new KernelHttpError(504, "kernel_upstream_timeout", `Kernel upstream exceeded ${this.hybridRouting.kernelRequestTimeoutMs} ms`);
      }
      throw new KernelHttpError(502, "kernel_upstream_unavailable", error instanceof Error ? error.message : "Kernel upstream response failed");
    } finally {
      upstream.cancelTimeout();
    }
  }

  private async relayKernelResponse(
    req: IncomingMessage,
    res: ServerResponse,
    upstream: KernelUpstreamResponse,
    bufferedBody?: Buffer,
  ): Promise<void> {
    const { response } = upstream;
    const omitted = new Set(["connection", "content-encoding", "content-length", "keep-alive", "transfer-encoding", "upgrade"]);
    for (const name of String(response.headers.get("connection") || "").split(",")) {
      if (name.trim()) omitted.add(name.trim().toLowerCase());
    }
    response.headers.forEach((value, name) => {
      if (!omitted.has(name.toLowerCase())) res.setHeader(name, value);
    });
    if (bufferedBody) res.setHeader("content-length", String(bufferedBody.length));
    res.writeHead(response.status);
    try {
      if (req.method === "HEAD" || response.status === 204 || response.status === 304) {
        res.end();
        return;
      }
      if (bufferedBody) {
        res.end(bufferedBody);
        return;
      }
      if (!response.body) {
        res.end();
        return;
      }
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (!res.write(Buffer.from(chunk))) await once(res, "drain");
      }
      res.end();
    } finally {
      upstream.cancelTimeout();
    }
  }

  private async routeHybridBrowserRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!this.hybridRouting.kernelApiKey) return false;
    const method = req.method || "GET";
    if (method === "POST" && url.pathname === "/browsers") {
      if (this.hybridRouting.kernelTrafficPercent <= 0
        || Math.random() * 100 >= this.hybridRouting.kernelTrafficPercent) return false;
      try {
        const upstream = await this.fetchKernelUpstream(req, url);
        if (!upstream.response.ok
          && this.hybridRouting.fallbackToArkerOnCreateError
          && isRetryableKernelCreateStatus(upstream.response.status)) {
          await this.discardKernelResponse(upstream);
          return false;
        }
        const responseBody = await this.readKernelResponseBody(upstream);
        if (upstream.response.ok) {
          try {
            const result = JSON.parse(responseBody.toString("utf8")) as { session_id?: unknown; name?: unknown };
            const requestBody = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { name?: unknown };
            if (typeof result.session_id === "string" && result.session_id) {
              const name = typeof result.name === "string" && result.name
                ? result.name
                : typeof requestBody.name === "string" && requestBody.name ? requestBody.name : undefined;
              await this.rememberBrowserProvider(result.session_id, "kernel", name);
            }
          } catch {
            // Preserve an otherwise valid upstream response even if a future
            // Kernel response shape cannot be recorded for restart affinity.
          }
        }
        await this.relayKernelResponse(req, res, upstream, responseBody);
        return true;
      } catch (error) {
        if (this.hybridRouting.fallbackToArkerOnTransportError
          && error instanceof KernelHttpError
          && (error.code === "kernel_upstream_timeout" || error.code === "kernel_upstream_unavailable")) return false;
        throw error;
      }
    }

    const match = url.pathname.match(/^\/browsers\/([^/]+)(?:\/|$)/);
    if (!match) return false;
    const reference = decodeURIComponent(match[1]!);
    const provider = this.browserProviders.get(reference);
    if (provider === "arker" || (!provider && isLikelyArkerBrowserReference(reference))) return false;
    if (provider !== "kernel" && !this.hybridRouting.fallbackToArkerOnNotFound) return false;

    const upstream = await this.fetchKernelUpstream(req, url);
    if (upstream.response.status === 404 && this.hybridRouting.fallbackToArkerOnNotFound) {
      await this.discardKernelResponse(upstream);
      await this.rememberBrowserProvider(reference, "arker");
      return false;
    }
    if (upstream.response.ok && !provider) await this.rememberBrowserProvider(reference, "kernel");
    if (method === "DELETE" && upstream.response.ok) await this.forgetBrowserProvider(reference);
    await this.relayKernelResponse(req, res, upstream);
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || "/", this.publicBaseUrl(req));
      if (url.pathname === "/health" || url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "arker-kernel-proxy" });
        return;
      }
      if (url.pathname.startsWith("/browser/live/")) {
        await this.proxyLiveView(req, res, url);
        return;
      }
      if (url.pathname.startsWith("/browser/direct/")) {
        await this.directBrowser(req, res, url);
        return;
      }
      this.authenticate(req);
      if (await this.routeHybridBrowserRequest(req, res, url)) return;
      await this.route(req, res, url);
    } catch (error) {
      const mapped = mapError(error);
      if (!res.headersSent) sendJson(res, mapped.status, kernelErrorBody(mapped.code, mapped.message));
      else res.end();
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method || "GET";
    if (url.pathname === "/profiles") {
      if (method === "GET") return this.listProfiles(res, url);
      if (method === "POST") return this.createProfile(req, res);
    }
    let controlMatch = url.pathname.match(/^\/profiles\/([^/]+)\/download$/);
    if (controlMatch && method === "GET") return this.downloadProfile(res, url, decodeURIComponent(controlMatch[1]!));
    controlMatch = url.pathname.match(/^\/profiles\/([^/]+)$/);
    if (controlMatch) {
      const id = decodeURIComponent(controlMatch[1]!);
      if (method === "GET") return this.retrieveProfile(res, id);
      if (method === "PATCH") return this.updateProfile(req, res, id);
      if (method === "DELETE") return this.deleteProfile(res, id);
    }

    if (url.pathname === "/extensions/from_chrome_store" && method === "GET") return this.downloadChromeStoreExtension(res, url);
    if (url.pathname === "/extensions") {
      if (method === "GET") return this.listExtensions(res, url);
      if (method === "POST") return this.uploadExtension(req, res);
    }
    controlMatch = url.pathname.match(/^\/extensions\/([^/]+)\/metadata$/);
    if (controlMatch && method === "GET") return this.retrieveExtension(res, decodeURIComponent(controlMatch[1]!));
    controlMatch = url.pathname.match(/^\/extensions\/([^/]+)$/);
    if (controlMatch) {
      const id = decodeURIComponent(controlMatch[1]!);
      if (method === "GET") return this.downloadExtension(res, id);
      if (method === "DELETE") return this.deleteExtension(res, id);
    }

    if (url.pathname === "/proxies") {
      if (method === "GET") return this.listProxies(res, url);
      if (method === "POST") return this.createProxy(req, res);
    }
    controlMatch = url.pathname.match(/^\/proxies\/([^/]+)\/check$/);
    if (controlMatch && method === "POST") return this.checkProxy(req, res, decodeURIComponent(controlMatch[1]!));
    controlMatch = url.pathname.match(/^\/proxies\/([^/]+)$/);
    if (controlMatch) {
      const id = decodeURIComponent(controlMatch[1]!);
      if (method === "GET") return this.retrieveProxy(res, id);
      if (method === "PATCH") return this.updateProxy(req, res, id);
      if (method === "DELETE") return this.deleteProxy(res, id);
    }

    if (url.pathname === "/browser_pools") {
      if (method === "GET") return this.listBrowserPools(res, url);
      if (method === "POST") return this.createBrowserPool(req, res);
    }
    controlMatch = url.pathname.match(/^\/browser_pools\/([^/]+)\/(acquire|flush|release)$/);
    if (controlMatch && method === "POST") {
      const id = decodeURIComponent(controlMatch[1]!);
      if (controlMatch[2] === "acquire") return this.acquireBrowserPool(req, res, id);
      if (controlMatch[2] === "flush") return this.flushBrowserPool(res, id);
      return this.releaseBrowserPool(req, res, id);
    }
    controlMatch = url.pathname.match(/^\/browser_pools\/([^/]+)$/);
    if (controlMatch) {
      const id = decodeURIComponent(controlMatch[1]!);
      if (method === "GET") return this.retrieveBrowserPool(res, id);
      if (method === "PATCH") return this.updateBrowserPool(req, res, id);
      if (method === "DELETE") return this.deleteBrowserPool(req, res, id);
    }

    if (method === "GET" && url.pathname === "/browsers") return this.listBrowsers(req, res, url);
    if (method === "POST" && url.pathname === "/browsers") return this.createBrowser(req, res);

    let match = url.pathname.match(/^\/browsers\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (method === "GET") return this.retrieveBrowser(req, res, id);
      if (method === "PATCH") return this.updateBrowser(req, res, id);
      if (method === "DELETE") return this.deleteBrowser(res, id);
    }

    match = url.pathname.match(/^\/browsers\/([^/]+)\/process\/(exec|spawn)$/);
    if (match && method === "POST") return this.processStart(req, res, decodeURIComponent(match[1]!), match[2]! === "spawn");
    match = url.pathname.match(/^\/browsers\/([^/]+)\/process\/([^/]+)\/(status|kill|stdin|resize)$/);
    if (match) return this.processOperation(req, res, decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), match[3]!);
    match = url.pathname.match(/^\/browsers\/([^/]+)\/process\/([^/]+)\/stdout\/stream$/);
    if (match && method === "GET") return this.processStream(res, decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));

    match = url.pathname.match(/^\/browsers\/([^/]+)\/fs\/watch$/);
    if (match && method === "POST") return this.watchStart(req, res, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/fs\/watch\/([^/]+)\/events$/);
    if (match && method === "GET") return this.watchEvents(res, decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/fs\/watch\/([^/]+)$/);
    if (match && method === "DELETE") return this.watchStop(res, decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/fs\/(.+)$/);
    if (match) return this.filesystem(req, res, url, decodeURIComponent(match[1]!), match[2]!);

    match = url.pathname.match(/^\/browsers\/([^/]+)\/playwright\/execute$/);
    if (match && method === "POST") return this.playwright(req, res, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/curl$/);
    if (match && method === "POST") return this.browserCurl(req, res, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/computer\/(.+)$/);
    if (match && method === "POST") return this.computer(req, res, decodeURIComponent(match[1]!), match[2]!);
    match = url.pathname.match(/^\/browsers\/([^/]+)\/logs\/stream$/);
    if (match && method === "GET") return this.logs(res, url, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/telemetry\/events$/);
    if (match && method === "GET") return this.telemetryEvents(res, url, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/telemetry\/stream$/);
    if (match && method === "GET") return this.telemetryStream(req, res, url, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/extensions$/);
    if (match && method === "POST") return this.loadExtensions(req, res, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/replays$/);
    if (match && method === "GET") return this.listReplays(req, res, decodeURIComponent(match[1]!));
    if (match && method === "POST") return this.startReplay(req, res, decodeURIComponent(match[1]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/replays\/([^/]+)$/);
    if (match && method === "GET") return this.downloadReplay(res, decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
    match = url.pathname.match(/^\/browsers\/([^/]+)\/replays\/([^/]+)\/stop$/);
    if (match && method === "POST") return this.stopReplay(res, decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));

    const controlPlaneRoot = url.pathname.split("/", 3)[1];
    if (["apps", "deployments", "invocations", "credentials", "auth", "org", "audit-logs"].includes(controlPlaneRoot || "")) {
      throw new KernelHttpError(
        422,
        "unsupported_operation",
        `${controlPlaneRoot} belongs to Kernel's application or organization control plane and is outside this Arker browser-session shim`,
      );
    }

    throw new KernelHttpError(404, "not_found", `No Kernel-compatible route for ${method} ${url.pathname}`);
  }

  private browserResponse(req: IncomingMessage, record: BrowserRecord): Record<string, unknown> {
    const { vm, metadata } = record;
    const origin = this.publicBaseUrl(req);
    const wsOrigin = origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const cdpCapability = this.token("cdp", vm.id);
    const bidiCapability = this.token("bidi", vm.id);
    const directCapability = this.token("direct", vm.id);
    // Python 0.86 derives the direct-route credential from the CDP URL's
    // `jwt` query parameter, while TypeScript prefers the explicit response
    // field. CDP itself consumes `token`, keeping the capabilities distinct.
    const cdp = `${wsOrigin}/browser/cdp?session_id=${encodeURIComponent(vm.id)}&token=${cdpCapability}&jwt=${directCapability}`;
    const bidi = `${wsOrigin}/browser/bidi?session_id=${encodeURIComponent(vm.id)}&token=${bidiCapability}`;
    const result: Record<string, unknown> = {
      session_id: vm.id,
      created_at: metadata.createdAt,
      cdp_ws_url: cdp,
      webdriver_ws_url: metadata.bidiPath ? bidi : cdp,
      base_url: `${origin}/browser/direct/${encodeURIComponent(vm.id)}`,
      // TypeScript uses this explicit credential; Python 0.86 reads the same
      // value from the CDP URL's `jwt` query parameter above.
      jwt: directCapability,
      headless: metadata.headless,
      stealth: metadata.stealth,
      timeout_seconds: metadata.timeoutSeconds,
      gpu: false,
      kiosk_mode: Boolean(metadata.kioskMode),
      telemetry: metadata.telemetry ?? null,
      usage: { uptime_ms: Math.max(0, Date.now() - Date.parse(metadata.createdAt)) },
    };
    if (metadata.name) result.name = metadata.name;
    if (metadata.startUrl) result.start_url = metadata.startUrl;
    if (metadata.tags) result.tags = metadata.tags;
    if (metadata.viewport) result.viewport = metadata.viewport;
    if (metadata.chromePolicy && Object.keys(metadata.chromePolicy).length) result.chrome_policy = metadata.chromePolicy;
    if (metadata.profile) {
      result.profile = {
        id: metadata.profile.id,
        created_at: metadata.profile.createdAt ?? metadata.createdAt,
        ...(metadata.profile.name ? { name: metadata.profile.name } : {}),
      };
    }
    if (metadata.proxyId) result.proxy_id = metadata.proxyId;
    if (metadata.pool) result.pool = { id: metadata.pool.id, ...(metadata.pool.name ? { name: metadata.pool.name } : {}) };
    if (!metadata.headless) {
      const token = this.token("live", vm.id);
      result.browser_live_view_url = `${origin}/browser/live/${encodeURIComponent(vm.id)}/vnc.html?autoconnect=true&resize=scale&token=${token}&path=${encodeURIComponent(`browser/live/${vm.id}/websockify?token=${token}`)}`;
    }
    return result;
  }

  private async loadRecord(idOrName: string): Promise<BrowserRecord> {
    const cached = this.cache.get(idOrName);
    if (cached) {
      this.touch(cached);
      return cached;
    }
    let vm: VM;
    try {
      vm = await this.arker.getVm(idOrName);
    } catch (error) {
      // Kernel also accepts a browser name. Arker's point lookup is id-only,
      // so resolve names from the marked VM records after an id miss.
      const listed = await this.listAllVms().catch(() => null);
      if (!listed) throw mapError(error);
      for (const candidate of listed) {
        const description = (candidate as unknown as { description?: unknown }).description;
        if (typeof description !== "string" || !description.startsWith(METADATA_PREFIX)) continue;
        const candidateMetadata = await this.metadataForVm(candidate);
        if (candidateMetadata?.name !== idOrName) continue;
        const record = { vm: candidate, metadata: candidateMetadata };
        this.touch(record);
        this.cacheRecord(record);
        return record;
      }
      throw mapError(error);
    }
    const metadata = await this.metadataForVm(vm);
    if (!metadata) throw new KernelHttpError(404, "not_found", `Browser ${idOrName} not found`);
    const record = { vm, metadata };
    this.touch(record);
    this.cacheRecord(record);
    return record;
  }

  private async metadataForVm(vm: VM): Promise<BrowserMetadata | null> {
    const description = (vm as unknown as { description?: unknown }).description;
    const inline = decodeMetadata(description);
    if (inline) return inline;
    if (typeof description !== "string" || !description.startsWith(METADATA_PREFIX)) return null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await vm.sync(METADATA_PATH)));
      return parsed?.version === 1 ? (parsed as BrowserMetadata) : null;
    } catch {
      // A marker without a session file is a create that never completed.
      return null;
    }
  }

  private touch(record: BrowserRecord): void {
    record.metadata.lastActivityAt = isoNow();
  }

  private async persist(record: BrowserRecord): Promise<void> {
    record.metadata.updatedAt = isoNow();
    await record.vm.sync(METADATA_PATH, JSON.stringify(record.metadata));
    record.vm = await record.vm.refresh();
    this.cacheRecord(record);
  }

  private async listBrowsers(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const status = url.searchParams.get("status") || "active";
    if (!["active", "deleted", "all"].includes(status)) throw new KernelHttpError(422, "validation_error", "status must be active, deleted, or all");
    if (status === "deleted") {
      res.setHeader("x-has-more", "false");
      res.setHeader("x-next-offset", "0");
      return sendJson(res, 200, []);
    }
    const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
    const requestedOffset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0 || !Number.isInteger(requestedOffset) || requestedOffset < 0) {
      throw new KernelHttpError(422, "validation_error", "limit must be positive and offset must be non-negative integers");
    }
    const limit = Math.min(requestedLimit, 100);
    const offset = requestedOffset;
    const query = (url.searchParams.get("query") || "").toLowerCase();
    const tags = new Map<string, string>();
    for (const [key, value] of url.searchParams) {
      const match = key.match(/^tags\[([^\]]+)]$/);
      if (match) tags.set(match[1]!, value);
    }
    const listed = await this.listAllVms();
    const records: BrowserRecord[] = [];
    for (const vm of listed) {
      const description = (vm as unknown as { description?: unknown }).description;
      if (typeof description !== "string" || !description.startsWith(METADATA_PREFIX)) continue;
      const cached = this.cache.get(vm.id);
      const metadata = cached?.metadata ?? await this.metadataForVm(vm);
      if (!metadata) continue;
      const searchable = [
        vm.id,
        metadata.name,
        metadata.profile?.id,
        metadata.profile?.name,
        metadata.proxyId,
        metadata.pool?.id,
        metadata.pool?.name,
      ].filter(Boolean).join(" ").toLowerCase();
      if (query && !searchable.includes(query)) continue;
      if ([...tags].some(([key, value]) => metadata.tags?.[key] !== value)) continue;
      const record = cached ?? { vm, metadata };
      record.vm = vm;
      this.cacheRecord(record);
      records.push(record);
    }
    records.sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
    const page = records.slice(offset, offset + limit);
    const nextOffset = offset + page.length < records.length ? offset + page.length : 0;
    // Kernel's generated SDKs require these headers for automatic offset
    // pagination. Without them, iteration silently stops after the first page.
    res.setHeader("x-has-more", nextOffset > 0 ? "true" : "false");
    res.setHeader("x-next-offset", String(nextOffset));
    sendJson(res, 200, page.map((record) => this.browserResponse(req, record)));
  }

  private async listAllVms(): Promise<VM[]> {
    const vms: VM[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.arker.listVms({ limit: 100, cursor });
      vms.push(...page.vms);
      cursor = page.nextCursor || undefined;
    } while (cursor);
    return vms;
  }

  private async createBrowser(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const createStarted = performance.now();
    const traceId = randomUUID().slice(0, 12);
    const body = (await readJson(req)) as KernelBrowserCreate;
    if (body.invocation_id != null) {
      throw new KernelHttpError(422, "unsupported_operation", "invocation_id belongs to the Kernel application control plane and is not available in this browser-session shim");
    }
    if (body.gpu !== undefined && typeof body.gpu !== "boolean") throw new KernelHttpError(422, "validation_error", "gpu must be a boolean");
    if (body.gpu) throw new KernelHttpError(422, "unsupported_operation", "GPU browsers are not supported by this Arker proxy yet");
    const headless = body.headless ?? false;
    const stealth = body.stealth ?? false;
    const timeoutSeconds = body.timeout_seconds ?? 60;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new KernelHttpError(422, "validation_error", `timeout_seconds must be between 10 and ${MAX_TIMEOUT_SECONDS}`);
    }
    for (const [field, value] of [["headless", body.headless], ["stealth", body.stealth], ["kiosk_mode", body.kiosk_mode]] as const) {
      if (value !== undefined && typeof value !== "boolean") throw new KernelHttpError(422, "validation_error", `${field} must be a boolean`);
    }
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name)) {
      throw new KernelHttpError(422, "validation_error", "name must be a non-empty string");
    }
    if (body.start_url !== undefined && (typeof body.start_url !== "string" || !body.start_url)) {
      throw new KernelHttpError(422, "validation_error", "start_url must be a non-empty string");
    }
    const telemetry = telemetryOnCreate(body.telemetry);
    const requestedViewport = body.viewport == null ? {} : asObject(body.viewport);
    const width = requestedViewport.width ?? 1920;
    const height = requestedViewport.height ?? 1080;
    const refreshRate = requestedViewport.refresh_rate;
    if (typeof width !== "number" || !Number.isInteger(width) || width <= 0 || typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
      throw new KernelHttpError(422, "validation_error", "viewport width and height must be positive integers");
    }
    if (refreshRate !== undefined && (typeof refreshRate !== "number" || !Number.isInteger(refreshRate) || refreshRate <= 0)) {
      throw new KernelHttpError(422, "validation_error", "viewport refresh_rate must be a positive integer");
    }
    const viewport = {
      width,
      height,
      ...(refreshRate !== undefined ? { refresh_rate: refreshRate } : {}),
    };
    const tags = body.tags == null ? undefined : parseTags(body.tags);
    const chromePolicy = body.chrome_policy == null ? undefined : parseChromePolicy(body.chrome_policy);
    const associations = await this.resolveBrowserAssociations(body);
    if (body.name) {
      await this.ensureUniqueName(body.name);
      this.reservedNames.add(body.name);
    }
    const createdAt = isoNow();
    const provisional: BrowserMetadata = {
      version: 1,
      headless,
      stealth,
      timeoutSeconds,
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
      name: body.name,
      startUrl: body.start_url,
      tags,
      viewport,
      kioskMode: body.kiosk_mode,
      telemetry,
      chromePolicy,
      ...(associations.profile ? {
        profile: {
          id: associations.profile.record.id,
          ...(associations.profile.record.name ? { name: associations.profile.record.name } : {}),
          createdAt: associations.profile.record.createdAt,
        },
        profileSaveChanges: associations.profile.saveChanges,
      } : {}),
      ...(associations.proxy ? { proxyId: associations.proxy.id } : {}),
      ...(associations.extensions.length ? { extensionIds: associations.extensions.map((item) => item.record.id) } : {}),
      cdpPath: "/devtools/browser/pending",
      bidiPath: this.options.skipSetup ? "/session/pending" : undefined,
      hostname: "pending",
    };
    const creationToken = `${METADATA_PREFIX}${randomUUID()}`;
    provisional.creationToken = creationToken;
    const creationReconciliation: CreationReconciliation = {
      createdAtMs: Date.now(),
      scanIndex: 0,
      pendingRequests: 0,
      activeVmIds: new Set(),
    };
    this.creationReconciliations.set(creationToken, creationReconciliation);
    const policies = {
      policies: [
        { type: "inbound" as const, match: { ports: headless ? [9222, 9230, 9515] : [6080, 9222, 9230, 9515] }, action: "allow" as const, auth: "arker" as const },
        { type: "outbound" as const, action: "allow" as const },
      ],
    };
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.options.createAttempts; attempt += 1) {
        let vm: VM | undefined;
        try {
          creationReconciliation.pendingRequests += 1;
          const durableSetupFork = !this.options.skipSetup && !this.options.sourceVmId;
          const forkOptions = {
            name: body.name || `kernel-${randomUUID().slice(0, 12)}`,
            // The per-create suffix lets the reconciler distinguish a late
            // ambiguous fork from every unrelated proxy-owned VM.
            description: creationToken,
            policies,
            ...(this.options.sourceLayers ? { layers: this.options.sourceLayers } : {}),
          };
          try {
            const forkStarted = performance.now();
            vm = this.options.sourceVmId
              ? await this.arker.fork({ sourceVmId: this.options.sourceVmId, ...forkOptions })
              : await this.arker.fork(this.options.sourceVmName, {
                  ...forkOptions,
                  name: durableSetupFork ? `${String(forkOptions.name).slice(0, 220)}-setup-${randomUUID().slice(0, 12)}` : forkOptions.name,
                  platforms: this.options.sourcePlatforms,
                });
            this.debugTiming("browser-create.fork", forkStarted, { trace_id: traceId, vm_id: vm.id, attempt });
          } finally {
            creationReconciliation.pendingRequests -= 1;
          }
          creationReconciliation.activeVmIds.add(vm.id);
          // A disk+memory fork returns an already-running clone of the pinned
          // prepared source. Adopt that state so the first setup command is
          // also the keep-alive handshake instead of preceding it with a
          // redundant `run true` plus guest-file read.
          if (this.options.sourceVmId && this.options.sourceLayers?.includes("memory")) {
            this.knownAwakeVms.add(vm.id);
          }
          if (durableSetupFork) {
            const builder = vm;
            await this.withVmPinned(builder, async () => {
              await this.setupGuest(builder, body, viewport, associations);
              await this.quiesceGuestForDiskFork(builder);
            });
            await builder.run("sync", {
              timeout: 120,
              session_idx: SERVICE_SESSION_INDEX,
              keep_alive: false,
              release: "cpu,memory",
              idempotencyKey: randomUUID(),
            });
            creationReconciliation.pendingRequests += 1;
            let sessionVm: VM;
            try {
              sessionVm = await this.arker.fork({
                sourceVmId: builder.id,
                ...forkOptions,
                layers: ["disk"],
              });
            } finally {
              creationReconciliation.pendingRequests -= 1;
            }
            creationReconciliation.activeVmIds.add(sessionVm.id);
            try {
              await builder.delete();
              creationReconciliation.activeVmIds.delete(builder.id);
            } catch (error) {
              await sessionVm.delete().catch(() => undefined);
              creationReconciliation.activeVmIds.delete(sessionVm.id);
              throw error;
            }
            vm = sessionVm;
          }
          // Keep setup, service discovery, and metadata persistence in one
          // uninterrupted initialization window.
          const initializeStarted = performance.now();
          await this.withVmPinned(vm, async () => {
            let setupEndpoints: GuestEndpoints | undefined;
            if (!this.options.skipSetup) {
              if (durableSetupFork) {
                await this.runServiceChecked(vm!, "/opt/arker-kernel/start-services.sh /opt/arker-kernel/config.json", 180);
              } else {
                setupEndpoints = await this.setupGuest(vm!, body, viewport, associations);
              }
            }
            const currentResources = vm!.resources as { memory_mib?: number | null; vcpu?: number | null } | undefined;
            const needsResize = (this.options.runtimeMemoryMib !== undefined && currentResources?.memory_mib !== this.options.runtimeMemoryMib)
              || (this.options.runtimeVcpu !== undefined && currentResources?.vcpu !== this.options.runtimeVcpu);
            if (needsResize) {
              const resizeStarted = performance.now();
              await vm!.update({
                resources: {
                  memory_mib: this.options.runtimeMemoryMib ?? null,
                  vcpu: this.options.runtimeVcpu ?? null,
                  disk_mib: null,
                },
              });
              this.debugTiming("browser-create.resize", resizeStarted, { trace_id: traceId, vm_id: vm!.id });
            }
            let cdpPath = setupEndpoints?.cdpPath;
            let bidiPath = setupEndpoints?.bidiPath;
            if (!cdpPath) {
              const discovery = await this.runChecked(vm!, "curl -fsS --max-time 5 http://127.0.0.1:9222/json/version", 20);
              const parsed = JSON.parse(runText(discovery, "stdout"));
              const cdp = new URL(parsed.webSocketDebuggerUrl);
              cdpPath = `${cdp.pathname}${cdp.search}`;
            }
            let hostname = vm!.hostname;
            if (!hostname) {
              const policyStarted = performance.now();
              hostname = (await vm!.getPolicies()).hostname;
              this.debugTiming("browser-create.policy", policyStarted, { trace_id: traceId, vm_id: vm!.id });
            }
            if (!hostname) throw new Error("Arker did not return an inbound hostname");
            provisional.cdpPath = cdpPath;
            if (!this.options.skipSetup && !bidiPath) {
              const webdriver = await this.runChecked(vm!, "cat /run/arker-kernel/webdriver.json", 20);
              const webdriverPayload = JSON.parse(runText(webdriver, "stdout"));
              const bidiUrl = new URL(webdriverPayload.value.capabilities.webSocketUrl);
              bidiPath = `${bidiUrl.pathname}${bidiUrl.search}`;
            }
            if (bidiPath) provisional.bidiPath = bidiPath;
            provisional.hostname = hostname;
            // Guest package installation can take longer than Kernel's default
            // inactivity timeout. Start that clock when the browser becomes ready,
            // not when the backing VM fork began.
            provisional.lastActivityAt = isoNow();
            provisional.updatedAt = provisional.lastActivityAt;
            const metadataStarted = performance.now();
            await vm!.sync(METADATA_PATH, JSON.stringify(provisional));
            this.debugTiming("browser-create.metadata", metadataStarted, { trace_id: traceId, vm_id: vm!.id });
            const record = { vm: vm!, metadata: provisional };
            this.cacheRecord(record);
            await this.touchBrowserAssociations(associations);
            creationReconciliation.activeVmIds.clear();
            creationReconciliation.keepVmId = vm!.id;
            this.debugTiming("browser-create.initialize", initializeStarted, { trace_id: traceId, vm_id: vm!.id });
            this.debugTiming("browser-create.total", createStarted, { trace_id: traceId, vm_id: vm!.id, attempt });
            await this.rememberBrowserProvider(vm!.id, "arker", provisional.name);
            sendJson(res, 200, this.browserResponse(req, record));
          });
          return;
        } catch (error) {
          await vm?.delete().catch(() => {});
          if (vm) creationReconciliation.activeVmIds.delete(vm.id);
          lastError = error;
          if (attempt >= this.options.createAttempts || !isTransientArkerCreateFailure(error)) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        }
      }
      throw lastError;
    } finally {
      if (body.name) this.reservedNames.delete(body.name);
    }
  }

  private async quiesceGuestForDiskFork(vm: VM): Promise<void> {
    await this.runChecked(vm, [
      // A persistent Chromium context buffers cookies and other profile state.
      // Give the launcher time to run context.close() before archiving/forking;
      // a direct SIGKILL can produce a valid profile tar that silently omits
      // the caller's most recent browser state.
      "pkill -TERM -f '[/]opt/arker-kernel/start-browser.mjs' 2>/dev/null || true",
      "for _ in $(seq 1 150); do ! pgrep -f '[/]opt/arker-kernel/start-browser.mjs' >/dev/null && break; sleep 0.1; done",
      "pkill -KILL -f '[/]opt/arker-kernel/start-browser.mjs' 2>/dev/null || true",
      "pkill -TERM -f '[/]opt/arker-kernel/playwright-runner.mjs' 2>/dev/null || true",
      "pkill -TERM -x chromedriver 2>/dev/null || true",
      "sleep 0.25",
      "pkill -KILL -f '[/]opt/arker-kernel/playwright-runner.mjs' 2>/dev/null || true",
      "pkill -KILL -x chromedriver 2>/dev/null || true",
      "pkill -KILL -f '[w]ebsockify.*6080' 2>/dev/null || true",
      "pkill -KILL -x x11vnc 2>/dev/null || true",
      "pkill -KILL -x openbox 2>/dev/null || true",
      "pkill -KILL -x Xvfb 2>/dev/null || true",
      "pkill -KILL -x pulseaudio 2>/dev/null || true",
      "rm -f /run/arker-kernel/browser.pid /run/arker-kernel/playwright.pid /run/arker-kernel/chromedriver.pid /run/arker-kernel/webdriver.json",
      "sync",
    ].join("; "), 60);
  }

  private async setupGuest(
    vm: VM,
    body: KernelBrowserCreate,
    viewport: { width: number; height: number; refresh_rate?: number },
    associations: BrowserAssociations,
  ): Promise<GuestEndpoints> {
    const extensionPaths = associations.extensions.map((extension) => `/opt/arker-kernel/extensions/stored-${extension.record.id}`);
    const proxyAuthPath = associations.proxy?.config.username === undefined
      ? undefined
      : `/opt/arker-kernel/extensions/proxy-auth-${associations.proxy.id}`;
    const loadedExtensionPaths = [...extensionPaths, ...(proxyAuthPath ? [proxyAuthPath] : [])];
    const proxyHost = associations.proxy?.config.host.includes(":") && !associations.proxy.config.host.startsWith("[")
      ? `[${associations.proxy.config.host}]`
      : associations.proxy?.config.host;
    const proxyArgs = associations.proxy ? [
      `--proxy-server=${associations.proxy.protocol}://${proxyHost}:${associations.proxy.config.port}`,
      ...(associations.proxy.bypassHosts.length ? [`--proxy-bypass-list=${associations.proxy.bypassHosts.join(";")}`] : []),
    ] : [];
    const browserArgs = [
      ...(this.options.browserArgs ?? []),
      ...(body.kiosk_mode ? ["--kiosk"] : []),
      ...proxyArgs,
      ...(loadedExtensionPaths.length ? [
        `--disable-extensions-except=${loadedExtensionPaths.join(",")}`,
        `--load-extension=${loadedExtensionPaths.join(",")}`,
      ] : []),
    ];
    // `/tmp` is bind-mounted onto the persistent session directory by the
    // setup script. Stage imports under /var/lib so that mount cannot hide
    // host-synced archives before extraction.
    const profileArchivePath = associations.profile?.archive ? "/var/lib/arker-kernel/imports/profile.tar" : undefined;
    if (profileArchivePath || associations.extensions.length > 0) {
      await this.runChecked(vm, "mkdir -p /var/lib/arker-kernel/imports", 30);
    }
    if (associations.profile?.archive) await vm.sync(profileArchivePath!, associations.profile.archive);
    const extensionArchives: Array<{ archivePath: string; destination: string }> = [];
    for (let index = 0; index < associations.extensions.length; index += 1) {
      const archivePath = `/var/lib/arker-kernel/imports/extension-${associations.extensions[index]!.record.id}.zip`;
      await vm.sync(archivePath, associations.extensions[index]!.archive);
      extensionArchives.push({ archivePath, destination: extensionPaths[index]! });
    }
    const config = {
      headless: body.headless ?? false,
      stealth: body.stealth ?? false,
      startUrl: body.start_url || "about:blank",
      viewport,
      cloakbrowserBinaryVersion: this.options.cloakbrowserBinaryVersion ?? env("CLOAKBROWSER_VERSION") ?? "146.0.7680.177.5",
      cloakbrowserLicenseKey: this.options.cloakbrowserLicenseKey ?? env("CLOAKBROWSER_LICENSE_KEY"),
      browserArgs,
      chromePolicy: body.chrome_policy == null ? {} : parseChromePolicy(body.chrome_policy),
      telemetry: telemetryOnCreate(body.telemetry),
      lowMemoryMode: this.options.runtimeMemoryMib !== undefined && this.options.runtimeMemoryMib <= 512,
      profilePath: "/var/lib/arker-kernel/profile",
      profileReset: Boolean(associations.profile),
      ...(profileArchivePath ? { profileArchivePath } : {}),
      ...(extensionArchives.length ? { extensionArchives } : {}),
      ...(associations.proxy ? {
        proxy: {
          protocol: associations.proxy.protocol,
          host: associations.proxy.config.host,
          port: associations.proxy.config.port,
          ...(associations.proxy.config.username === undefined ? {} : { username: associations.proxy.config.username }),
          ...(associations.proxy.config.password === undefined ? {} : { password: associations.proxy.config.password }),
          ...(associations.proxy.config.caBundle === undefined ? {} : { caBundle: associations.proxy.config.caBundle }),
          ...(proxyAuthPath ? { extensionPath: proxyAuthPath } : {}),
        },
      } : {}),
    };
    // An explicit sourceVmId selects the prepared-source path. Its disk
    // already carries apt/npm/CloakBrowser/ChromeDriver, so refresh only the
    // editable runtime assets and per-session config.
    return this.runGuestSetup(vm, JSON.stringify(config), this.options.sourceVmId ? "assets" : undefined);
  }

  private async reconfigureGuest(
    record: BrowserRecord,
    change: { profile?: BrowserAssociations["profile"]; proxy?: StoredProxy | null },
  ): Promise<void> {
    if (this.options.skipSetup) return;
    const config = JSON.parse(new TextDecoder().decode(await record.vm.sync("/opt/arker-kernel/config.json"))) as Record<string, unknown>;
    if (change.profile) {
      config.profileReset = true;
      if (change.profile.archive) {
        const archivePath = "/tmp/arker-kernel-profile.tar";
        await record.vm.sync(archivePath, change.profile.archive);
        config.profileArchivePath = archivePath;
      } else {
        delete config.profileArchivePath;
      }
    }
    if (change.proxy !== undefined) {
      const authRoot = "/opt/arker-kernel/extensions/proxy-auth";
      const authPath = change.proxy?.config.username === undefined ? undefined : `${authRoot}-${change.proxy.id}`;
      const oldArgs = Array.isArray(config.browserArgs) ? config.browserArgs.filter((item): item is string => typeof item === "string") : [];
      const retained: string[] = [];
      let extensionPaths: string[] = [];
      for (const argument of oldArgs) {
        if (argument.startsWith("--proxy-server=") || argument.startsWith("--proxy-bypass-list=")) continue;
        if (argument.startsWith("--load-extension=") || argument.startsWith("--disable-extensions-except=")) {
          extensionPaths.push(...argument.slice(argument.indexOf("=") + 1).split(",").filter((path) => path && !path.startsWith(authRoot)));
          continue;
        }
        retained.push(argument);
      }
      extensionPaths = [...new Set(extensionPaths)];
      if (authPath) extensionPaths.push(authPath);
      if (change.proxy) {
        const host = change.proxy.config.host.includes(":") && !change.proxy.config.host.startsWith("[")
          ? `[${change.proxy.config.host}]`
          : change.proxy.config.host;
        retained.push(`--proxy-server=${change.proxy.protocol}://${host}:${change.proxy.config.port}`);
        if (change.proxy.bypassHosts.length) retained.push(`--proxy-bypass-list=${change.proxy.bypassHosts.join(";")}`);
        config.proxy = {
          protocol: change.proxy.protocol,
          host: change.proxy.config.host,
          port: change.proxy.config.port,
          ...(change.proxy.config.username === undefined ? {} : { username: change.proxy.config.username }),
          ...(change.proxy.config.password === undefined ? {} : { password: change.proxy.config.password }),
          ...(change.proxy.config.caBundle === undefined ? {} : { caBundle: change.proxy.config.caBundle }),
          ...(authPath ? { extensionPath: authPath } : {}),
        };
      } else {
        delete config.proxy;
      }
      if (extensionPaths.length) retained.push(
        `--disable-extensions-except=${extensionPaths.join(",")}`,
        `--load-extension=${extensionPaths.join(",")}`,
      );
      config.browserArgs = retained;
    }
    const endpoints = await this.runGuestSetup(record.vm, JSON.stringify(config));
    record.metadata.cdpPath = endpoints.cdpPath;
    record.metadata.bidiPath = endpoints.bidiPath;
    await this.persist(record);
  }

  private async runGuestSetup(
    vm: VM,
    config: string | Uint8Array,
    repairMode: "assets" | "full" | undefined = undefined,
  ): Promise<GuestEndpoints> {
    const guestSetupStarted = performance.now();
    const scriptPath = this.options.setupScriptPath ?? env("KERNEL_PROXY_SETUP_SCRIPT") ?? this.defaultSetupScriptPath();
    const script = await readFile(scriptPath);
    const setupFingerprint = createHash("sha256")
      .update(script)
      .update("\0")
      .update(this.options.cloakbrowserNpmVersion ?? env("CLOAKBROWSER_NPM_VERSION") ?? "0.5.5")
      .digest("hex");
    const configBytes = typeof config === "string" ? new TextEncoder().encode(config) : config;
    const configFingerprint = createHash("sha256").update(configBytes).digest("hex");
    if (this.options.sourceVmId && repairMode === "assets") {
      const cached = this.preparedRuntimeCache;
      if (cached
        && cached.sourceVmId === this.options.sourceVmId
        && cached.setupFingerprint === setupFingerprint
        && cached.configFingerprint === configFingerprint) {
        this.debugTiming("guest-setup.prepared-cache", guestSetupStarted, { vm_id: vm.id });
        this.debugTiming("guest-setup.total", guestSetupStarted, { vm_id: vm.id, inherited: true, cached: true });
        return { cdpPath: cached.cdpPath, bidiPath: cached.bidiPath };
      }
      const manifestStarted = performance.now();
      try {
        const manifest = JSON.parse(new TextDecoder().decode(
          await vm.sync("/opt/arker-kernel/prepared-runtime.json"),
        )) as { version?: unknown; setup_fingerprint?: unknown; config_sha256?: unknown; cdp?: unknown; bidi?: unknown };
        if (manifest.version === 1
          && manifest.setup_fingerprint === setupFingerprint
          && manifest.config_sha256 === configFingerprint
          && typeof manifest.cdp === "string"
          && typeof manifest.bidi === "string") {
          const cdp = new URL(manifest.cdp);
          const bidi = new URL(manifest.bidi);
          const endpoints = { cdpPath: `${cdp.pathname}${cdp.search}`, bidiPath: `${bidi.pathname}${bidi.search}` };
          this.preparedRuntimeCache = {
            ...endpoints,
            sourceVmId: this.options.sourceVmId,
            setupFingerprint,
            configFingerprint,
          };
          this.debugTiming("guest-setup.prepared-manifest", manifestStarted, { vm_id: vm.id });
          this.debugTiming("guest-setup.total", guestSetupStarted, { vm_id: vm.id, inherited: true });
          return endpoints;
        }
      } catch {
        // A stale prepared source is repaired below; absence or malformed
        // contents must never turn the acceleration hint into authority.
      }
      this.debugTiming("guest-setup.prepared-manifest-miss", manifestStarted, { vm_id: vm.id });
    }
    const configStarted = performance.now();
    await vm.sync("/tmp/arker-kernel-config.json", configBytes);
    this.debugTiming("guest-setup.config-upload", configStarted, { vm_id: vm.id });
    const npmVersion = this.options.cloakbrowserNpmVersion ?? env("CLOAKBROWSER_NPM_VERSION") ?? "0.5.5";
    const repairEnvironment = repairMode ? ` KERNEL_PROXY_REPAIR_RUNTIME=${shellQuote(repairMode)}` : "";
    const endpointMarker = "__ARKER_KERNEL_ENDPOINTS__";
    const setupCommand = (remoteScript: string) => [
      `chmod 700 ${shellQuote(remoteScript)} /tmp/arker-kernel-config.json`,
      `CLOAKBROWSER_NPM_VERSION=${shellQuote(npmVersion)} KERNEL_PROXY_SETUP_FINGERPRINT=${shellQuote(setupFingerprint)}${repairEnvironment} bash ${shellQuote(remoteScript)} /tmp/arker-kernel-config.json`,
      "CDP_URL=$(curl -fsS --max-time 5 http://127.0.0.1:9222/json/version | jq -r '.webSocketDebuggerUrl')",
      "BIDI_URL=$(jq -r '.value.capabilities.webSocketUrl' /run/arker-kernel/webdriver.json)",
      `printf '${endpointMarker}'`,
      "jq -Mnc --arg cdp \"$CDP_URL\" --arg bidi \"$BIDI_URL\" '{cdp:$cdp,bidi:$bidi}'",
    ].join(" && ");
    let result: CompletedRunResult | undefined;
    if (this.options.sourceVmId && repairMode === "assets") {
      const canonicalScript = "/opt/arker-kernel/setup-cloakbrowser.sh";
      const preparedCommand = [
        `if [[ \"$(cat /opt/arker-kernel/.setup-fingerprint 2>/dev/null || true)\" != ${shellQuote(setupFingerprint)} || ! -x ${shellQuote(canonicalScript)} ]]; then printf '__ARKER_KERNEL_SETUP_REQUIRED__'; exit 0; fi`,
        setupCommand(canonicalScript),
      ].join("; ");
      const preparedStarted = performance.now();
      result = await this.runServiceChecked(vm, preparedCommand, this.options.setupTimeoutSeconds);
      this.debugTiming("guest-setup.prepared-bootstrap", preparedStarted, { vm_id: vm.id });
      if (runText(result, "stdout").includes("__ARKER_KERNEL_SETUP_REQUIRED__")) result = undefined;
    }
    if (!result) {
      const scriptStarted = performance.now();
      await vm.sync("/tmp/arker-kernel-setup.sh", script);
      this.debugTiming("guest-setup.script-upload", scriptStarted, { vm_id: vm.id });
      const installStarted = performance.now();
      result = await this.runServiceChecked(
        vm,
        setupCommand("/tmp/arker-kernel-setup.sh"),
        this.options.setupTimeoutSeconds,
        repairMode === "assets" ? undefined : this.options.setupMemoryMib,
      );
      this.debugTiming("guest-setup.install-bootstrap", installStarted, { vm_id: vm.id });
    }
    const stdout = runText(result, "stdout");
    const marker = stdout.lastIndexOf(endpointMarker);
    if (marker < 0) throw new KernelHttpError(502, "execution_failed", "Guest setup did not return browser endpoints");
    const line = stdout.slice(marker + endpointMarker.length).trim().split(/\r?\n/, 1)[0]
      ?.replace(/\x1b\[[0-9;]*m/g, "");
    let payload: { cdp?: unknown; bidi?: unknown };
    try {
      payload = JSON.parse(line || "{}");
    } catch {
      throw new KernelHttpError(502, "execution_failed", `Guest setup returned invalid browser endpoints: ${JSON.stringify(line.slice(0, 500))}`);
    }
    if (typeof payload.cdp !== "string" || typeof payload.bidi !== "string") {
      throw new KernelHttpError(502, "execution_failed", "Guest setup omitted browser endpoints");
    }
    const cdp = new URL(payload.cdp);
    const bidi = new URL(payload.bidi);
    this.debugTiming("guest-setup.total", guestSetupStarted, { vm_id: vm.id });
    return { cdpPath: `${cdp.pathname}${cdp.search}`, bidiPath: `${bidi.pathname}${bidi.search}` };
  }

  private async repairGuestRuntime(record: BrowserRecord): Promise<void> {
    await this.withVmPinned(record.vm, async () => {
      let config: Uint8Array;
      try {
        config = await record.vm.sync("/opt/arker-kernel/config.json");
      } catch {
        config = new TextEncoder().encode(JSON.stringify({
          headless: record.metadata.headless,
          stealth: record.metadata.stealth,
          startUrl: record.metadata.startUrl || "about:blank",
          viewport: record.metadata.viewport ?? { width: 1920, height: 1080 },
          cloakbrowserBinaryVersion: this.options.cloakbrowserBinaryVersion ?? env("CLOAKBROWSER_VERSION") ?? "146.0.7680.177.5",
          cloakbrowserLicenseKey: this.options.cloakbrowserLicenseKey ?? env("CLOAKBROWSER_LICENSE_KEY"),
          browserArgs: [...(this.options.browserArgs ?? []), ...(record.metadata.kioskMode ? ["--kiosk"] : [])],
          chromePolicy: record.metadata.chromePolicy ?? {},
          telemetry: record.metadata.telemetry ?? null,
          lowMemoryMode: this.options.runtimeMemoryMib !== undefined && this.options.runtimeMemoryMib <= 512,
          profilePath: "/var/lib/arker-kernel/profile",
        }));
      }
      const dependenciesPresent = await this.runChecked(
        record.vm,
        "test -d /opt/arker-kernel/node_modules/playwright-core && test -d /opt/arker-kernel/node_modules/cloakbrowser && test -x /usr/local/bin/chromedriver",
        20,
      ).then(() => true, () => false);
      const endpoints = await this.runGuestSetup(record.vm, config, dependenciesPresent ? "assets" : "full");
      record.metadata.cdpPath = endpoints.cdpPath;
      record.metadata.bidiPath = endpoints.bidiPath;
      await this.persist(record);
    });
  }

  private async runServiceWithRepair(record: BrowserRecord, command: string, timeout: number): Promise<void> {
    try {
      await this.runServiceChecked(record.vm, command, timeout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.options.skipSetup || !/\/opt\/arker-kernel\/.*No such file or directory/i.test(message)) throw error;
      await this.repairGuestRuntime(record);
    }
  }

  private defaultSetupScriptPath(): string {
    const relative = join("scripts", "kernel-proxy", "setup-cloakbrowser.sh");
    const candidates = [
      join(process.cwd(), relative),
      join(dirname(process.argv[1] || process.cwd()), "..", relative),
    ];
    try {
      const require = createRequire(join(process.cwd(), "__arker_kernel_proxy__.cjs"));
      candidates.push(join(dirname(require.resolve("@arker-ai/sdk/kernel-proxy")), "..", relative));
    } catch {
      // The source checkout is not necessarily installed under its package name.
    }
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  }

  private async retrieveBrowser(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    this.touch(record);
    sendJson(res, 200, this.browserResponse(req, record));
  }

  private async updateBrowser(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const body = await readJson(req);
    const original = record.metadata;
    const updated = { ...original };
    let profileAssociation: BrowserAssociations["profile"];
    let proxyChange: StoredProxy | null | undefined;
    if (body.profile !== undefined) {
      if (body.profile === null) throw new KernelHttpError(422, "validation_error", "profile must be an object");
      if (record.metadata.profile) throw new KernelHttpError(409, "profile_already_loaded", "A profile is already loaded in this browser session");
      profileAssociation = (await this.resolveBrowserAssociations({ profile: body.profile })).profile;
      if (!profileAssociation) throw new KernelHttpError(422, "validation_error", "profile is required");
      updated.profile = {
        id: profileAssociation.record.id,
        ...(profileAssociation.record.name ? { name: profileAssociation.record.name } : {}),
        createdAt: profileAssociation.record.createdAt,
      };
      updated.profileSaveChanges = profileAssociation.saveChanges;
    }
    if (body.proxy_id !== undefined) {
      if (body.proxy_id === null || body.proxy_id === "") {
        proxyChange = null;
        updated.proxyId = undefined;
      } else {
        if (typeof body.proxy_id !== "string") throw new KernelHttpError(422, "validation_error", "proxy_id must be a string, null, or empty string");
        proxyChange = (await this.resolveBrowserAssociations({ proxy_id: body.proxy_id })).proxy;
        updated.proxyId = proxyChange!.id;
      }
    }
    if (body.disable_default_proxy !== undefined && typeof body.disable_default_proxy !== "boolean") {
      throw new KernelHttpError(422, "validation_error", "disable_default_proxy must be a boolean");
    }
    let reservedName: string | undefined;
    if (body.name !== undefined) {
      if (body.name !== null && typeof body.name !== "string") throw new KernelHttpError(422, "validation_error", "name must be a string or null");
      const name = typeof body.name === "string" && body.name ? body.name : undefined;
      if (name && name !== record.metadata.name) {
        await this.ensureUniqueName(name, record.vm.id);
        this.reservedNames.add(name);
        reservedName = name;
      }
      updated.name = name;
    }
    try {
      if (profileAssociation || proxyChange !== undefined) {
        await this.reconfigureGuest(record, { ...(profileAssociation ? { profile: profileAssociation } : {}), ...(proxyChange !== undefined ? { proxy: proxyChange } : {}) });
        // Preserve the refreshed protocol endpoints returned by reconfiguration.
        updated.cdpPath = record.metadata.cdpPath;
        updated.bidiPath = record.metadata.bidiPath;
        if (profileAssociation) await this.touchBrowserAssociations({ profile: profileAssociation, extensions: [] });
      }
      if (body.tags !== undefined) updated.tags = body.tags === null ? undefined : parseTags(body.tags);
      if (body.telemetry !== undefined) updated.telemetry = telemetryOnUpdate(updated.telemetry, body.telemetry);
      if (body.viewport != null) {
        const viewport = asObject(body.viewport);
        if (viewport.force !== undefined && typeof viewport.force !== "boolean") {
          throw new KernelHttpError(422, "validation_error", "viewport force must be a boolean");
        }
        const width = viewport.width ?? updated.viewport?.width;
        const height = viewport.height ?? updated.viewport?.height;
        const refreshRate = viewport.refresh_rate === undefined ? updated.viewport?.refresh_rate : viewport.refresh_rate;
        if (typeof width !== "number" || !Number.isInteger(width) || width <= 0 || typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
          throw new KernelHttpError(422, "validation_error", "viewport width and height must be positive integers");
        }
        if (refreshRate !== undefined && (typeof refreshRate !== "number" || !Number.isInteger(refreshRate) || refreshRate <= 0)) {
          throw new KernelHttpError(422, "validation_error", "viewport refresh_rate must be a positive integer");
        }
        const activeReplays = [...this.browserReplays.entries()].filter(([, replay]) => replay.vm.id === record.vm.id && !replay.finishedAt);
        const hasLiveView = (this.activeLiveConnections.get(record.vm.id) ?? 0) > 0;
        if ((hasLiveView || activeReplays.length > 0) && viewport.force !== true) {
          throw new KernelHttpError(409, "viewport_in_use", "Viewport cannot be changed while a live view or replay is active; use force=true");
        }
        const replaySegments = activeReplays.map(([, replay]) => ({
          fps: replay.fps,
          recordAudio: replay.recordAudio,
          expiresAtMs: replay.expiresAtMs,
        }));
        for (const [replayId, replay] of activeReplays) await this.finishReplay(replayId, replay);
        updated.viewport = { width, height, ...(refreshRate === undefined ? {} : { refresh_rate: refreshRate }) };
        const payload = await this.executePlaywright(record, `await page.setViewportSize(${JSON.stringify({ width, height })}); return true;`);
        if (!payload.success) throw new KernelHttpError(502, "computer_action_failed", String(payload.error || "viewport update failed"));
        for (const segment of replaySegments) {
          const remainingSeconds = (segment.expiresAtMs - Date.now()) / 1_000;
          if (remainingSeconds > 0) await this.beginReplay(record, segment.fps, remainingSeconds, segment.recordAudio);
        }
      }
      if (body.telemetry !== undefined && !this.options.skipSetup) {
        await this.updateGuestTelemetry(record, updated.telemetry);
      }
      updated.lastActivityAt = isoNow();
      record.metadata = updated;
      try {
        await this.persist(record);
      } catch (error) {
        record.metadata = original;
        this.cacheRecord(record);
        if (body.telemetry !== undefined && !this.options.skipSetup) {
          await this.updateGuestTelemetry(record, original.telemetry).catch(() => undefined);
        }
        throw error;
      }
      sendJson(res, 200, this.browserResponse(req, record));
    } finally {
      if (reservedName) this.reservedNames.delete(reservedName);
    }
  }

  private async updateGuestTelemetry(record: BrowserRecord, telemetry: unknown): Promise<void> {
    const update = "import json,sys; p=sys.argv[1]; q=json.load(open(p)); q['telemetry']=json.loads(sys.argv[2]); json.dump(q,open(p,'w'))";
    await this.runChecked(record.vm, `python3 -c ${shellQuote(update)} /opt/arker-kernel/config.json ${shellQuote(JSON.stringify(telemetry ?? null))}`, 30);
    await this.withVmControl(record.vm.id, () => this.runServiceWithRepair(record, "/opt/arker-kernel/start-playwright-runner.sh", 45));
  }

  private async saveProfileChanges(record: BrowserRecord): Promise<void> {
    const profileId = record.metadata.profile?.id;
    if (!profileId || !record.metadata.profileSaveChanges || this.options.skipSetup) return;
    const exists = await this.withState((state) => state.profiles.some((profile) => profile.id === profileId));
    if (!exists) return;
    // Synchronize with the persistent context before archiving profile state.
    await this.executePlaywright(record, "await context.cookies(); return true;", 30).catch(() => undefined);
    await this.withVmControl(record.vm.id, () => this.quiesceGuestForDiskFork(record.vm));
    const remote = `/var/lib/arker-kernel/profile-${randomUUID()}.tar`;
    try {
      await this.runChecked(record.vm, `tar -C /var/lib/arker-kernel/profile -cf ${shellQuote(remote)} .`, 300);
      const archive = Buffer.from(await record.vm.sync(remote));
      await this.withState(async (state) => {
        const profile = state.profiles.find((item) => item.id === profileId);
        if (!profile) return;
        await mkdir(join(this.options.stateDirectory, "profiles"), { recursive: true, mode: 0o700 });
        const temporary = `${this.profilePath(profileId)}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, archive, { mode: 0o600 });
          await rename(temporary, this.profilePath(profileId));
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        profile.hasArchive = true;
        profile.updatedAt = isoNow();
        profile.lastUsedAt = profile.updatedAt;
      }, true);
    } finally {
      await this.runChecked(record.vm, `rm -f ${shellQuote(remote)}`, 30).catch(() => undefined);
    }
    await this.refreshIdlePoolsForProfile(profileId);
  }

  private async deleteBrowser(res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    await this.cleanupBrowserResources(record.vm.id);
    await this.saveProfileChanges(record);
    await record.vm.delete();
    this.forgetRecord(record);
    sendEmpty(res, 204);
  }

  private async processStart(req: IncomingMessage, res: ServerResponse, id: string, spawn: boolean): Promise<void> {
    const record = await this.loadRecord(id);
    const params = parseProcessParams(await readJson(req));
    const command = commandFor(params);
    this.touch(record);
    if (spawn) {
      await this.acquireVmPin(record.vm);
      let pinHandedOff = false;
      try {
      if (params.allocate_tty) {
        const processId = `pty-${randomUUID()}`;
        const connection = await record.vm.connectPty({
          command,
          cols: params.cols,
          rows: params.rows,
          persist: true,
        });
        const process: InteractiveProcess = {
          vm: record.vm,
          connection,
          output: [],
          outputBytes: 0,
          nextOutputSequence: 0,
          state: "running",
          exitCode: null,
          pinHeld: true,
        };
        this.interactiveProcesses.set(processId, process);
        pinHandedOff = true;
        connection.onData((data) => {
          const chunk = Buffer.from(data);
          process.output.push({ sequence: process.nextOutputSequence++, data: chunk });
          process.outputBytes += chunk.length;
          while (process.outputBytes > MAX_PROCESS_OUTPUT_BYTES && process.output.length > 1) {
            process.outputBytes -= process.output.shift()!.data.length;
          }
        });
        connection.onClose(() => {
          if (process.timeout) clearTimeout(process.timeout);
          process.state = "exited";
          process.exitCode ??= 0;
          void process.vm.deleteSession(connection.sessionId).catch(() => undefined);
          void this.releaseInteractivePin(process);
        });
        connection.onError(() => {
          if (process.timeout) clearTimeout(process.timeout);
          process.state = "exited";
          process.exitCode ??= 1;
          void process.vm.deleteSession(connection.sessionId).catch(() => undefined);
          void this.releaseInteractivePin(process);
        });
        await connection.ready;
        if (params.timeout_sec && params.timeout_sec > 0) {
          process.timeout = setTimeout(() => {
            if (process.state !== "running") return;
            process.exitCode = 137;
            void process.vm.signal("SIGKILL", { sessionId: connection.sessionId })
              .catch(() => undefined)
              .finally(() => {
                process.state = "exited";
                connection.close();
                void process.vm.deleteSession(connection.sessionId).catch(() => undefined);
              });
          }, params.timeout_sec * 1000);
          process.timeout.unref?.();
        }
        sendJson(res, 200, { process_id: processId, started_at: isoNow() });
        return;
      }
      const processId = `proc-${randomUUID()}`;
      const directory = `/tmp/arker-kernel-process-${processId}`;
      const signalPath = `${directory}/signal`;
      const childExecution = params.timeout_sec
        ? `timeout --signal=KILL ${Math.max(1, Number(params.timeout_sec))} /bin/bash -lc ${shellQuote(command)}`
        : `/bin/bash -lc ${shellQuote(command)}`;
      // The supervisor keeps Arker's run attached until the child exits. Kill
      // requests arrive through the filesystem channel, so they cannot queue
      // behind the very process they need to stop, and `setsid` isolates the
      // complete descendant tree in one signalable process group.
      const supervisor = [
        `signal_file=${shellQuote(signalPath)}`,
        `setsid --wait ${childExecution} & child=$!`,
        `while kill -0 "$child" 2>/dev/null; do if [ -s "$signal_file" ]; then signal=$(cat "$signal_file"); : > "$signal_file"; kill -s "$signal" -- "-$child" 2>/dev/null || true; fi; sleep 0.1; done`,
        `wait "$child"`,
      ].join("; ");
      // Arker's persistent shell is interactive and prints job-control
      // notifications for `&`. Keep the supervisor in a non-interactive
      // wrapper so Kernel receives only the spawned command's output.
      const wrappedSupervisor = `/bin/bash -lc ${shellQuote(supervisor)}`;
      const detached = await this.withVmControl(record.vm.id, async () => {
        await record.vm.sync(signalPath, "");
        const session = await record.vm.createSession();
        try {
          const result = await record.vm.run(wrappedSupervisor, {
            background: true,
            timeout: params.timeout_sec ?? undefined,
            session_id: session.session_id,
          });
          return { vm: record.vm, runId: result.runId, sessionId: session.session_id, signalPath, pinHeld: true };
        } catch (error) {
          await record.vm.deleteSession(session.session_id).catch(() => undefined);
          throw error;
        }
      });
      this.detachedProcesses.set(processId, detached);
      pinHandedOff = true;
      sendJson(res, 200, { process_id: processId, started_at: isoNow() });
      return;
      } finally {
        if (!pinHandedOff) await this.releaseVmPin(record.vm);
      }
    }
    const started = Date.now();
    await this.withVmPinned(record.vm, async () => {
      const result = await this.runChecked(record.vm, command, params.timeout_sec ?? undefined);
      sendJson(res, 200, {
        exit_code: result.exitCode,
        stdout_b64: Buffer.from(runBytes(result, "stdout")).toString("base64"),
        stderr_b64: Buffer.from(runBytes(result, "stderr")).toString("base64"),
        duration_ms: Date.now() - started,
      });
    });
  }

  private async processOperation(req: IncomingMessage, res: ServerResponse, id: string, processId: string, operation: string): Promise<void> {
    const record = await this.loadRecord(id);
    this.touch(record);
    const interactive = this.interactiveProcesses.get(processId);
    if (interactive) {
      if (interactive.vm.id !== record.vm.id) throw new KernelHttpError(404, "not_found", `Process ${processId} not found for browser ${record.vm.id}`);
      if (operation === "status" && req.method === "GET") {
        sendJson(res, 200, { state: interactive.state, exit_code: interactive.exitCode });
        return;
      }
      if (operation === "kill" && req.method === "POST") {
        const body = await readJson(req);
        const signals = { TERM: "SIGTERM", KILL: "SIGKILL", INT: "SIGINT", HUP: "SIGHUP" } as const;
        const signalName = String(body.signal || "TERM").toUpperCase().replace(/^SIG/, "");
        if (!(signalName in signals)) throw new KernelHttpError(422, "validation_error", "signal must be TERM, KILL, INT, or HUP");
        const signal = signals[signalName as keyof typeof signals];
        if (interactive.timeout) clearTimeout(interactive.timeout);
        interactive.exitCode = signal === "SIGKILL" ? 137 : signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
        await interactive.vm.signal(signal, { sessionId: interactive.connection.sessionId });
        interactive.state = "exited";
        interactive.connection.close();
        await interactive.vm.deleteSession(interactive.connection.sessionId).catch(() => undefined);
        await this.releaseInteractivePin(interactive);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (operation === "stdin" && req.method === "POST") {
        const body = await readJson(req);
        const data = decodeBase64(body.data_b64, "data_b64");
        interactive.connection.send(data);
        sendJson(res, 200, { written_bytes: data.length });
        return;
      }
      if (operation === "resize" && req.method === "POST") {
        const body = await readJson(req);
        if (!Number.isInteger(body.cols) || Number(body.cols) <= 0 || !Number.isInteger(body.rows) || Number(body.rows) <= 0) {
          throw new KernelHttpError(422, "validation_error", "cols and rows must be positive integers");
        }
        interactive.connection.resize(Number(body.cols), Number(body.rows));
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    const detached = this.detachedProcesses.get(processId);
    if (detached) {
      if (detached.vm.id !== record.vm.id) throw new KernelHttpError(404, "not_found", `Process ${processId} not found for browser ${record.vm.id}`);
      if (operation === "status" && req.method === "GET") {
        const run = await detached.vm.getRun(detached.runId);
        if (run.state !== "running") await this.releaseDetachedSession(detached);
        sendJson(res, 200, { state: run.state === "running" ? "running" : "exited", exit_code: run.exit_code ?? null });
        return;
      }
      if (operation === "kill" && req.method === "POST") {
        const body = await readJson(req);
        const signals = { TERM: "SIGTERM", KILL: "SIGKILL", INT: "SIGINT", HUP: "SIGHUP" } as const;
        const signalName = String(body.signal || "TERM").toUpperCase().replace(/^SIG/, "");
        if (!(signalName in signals)) throw new KernelHttpError(422, "validation_error", "signal must be TERM, KILL, INT, or HUP");
        const signal = signals[signalName as keyof typeof signals];
        await this.withVmControl(detached.vm.id, async () => {
          await detached.vm.sync(detached.signalPath, signal.slice(3));
          const deadline = Date.now() + 10_000;
          for (;;) {
            const run = await detached.vm.getRun(detached.runId);
            if (run.state !== "running") break;
            if (Date.now() >= deadline) {
              throw new KernelHttpError(504, "process_kill_timeout", `process ${processId} did not exit after ${signal}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await this.releaseDetachedSession(detached);
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (operation === "stdin" || operation === "resize") throw new KernelHttpError(422, "validation_error", `${processId} is not PTY-backed`);
    }
    if (operation === "stdin" || operation === "resize") throw new KernelHttpError(422, "validation_error", `${processId} is not a PTY-backed process`);
    throw new KernelHttpError(404, "not_found", `Process ${processId} is not known to this proxy process`);
  }

  private async processStream(res: ServerResponse, id: string, processId: string): Promise<void> {
    const record = await this.loadRecord(id);
    const interactive = this.interactiveProcesses.get(processId);
    const detached = this.detachedProcesses.get(processId);
    if ((interactive && interactive.vm.id !== record.vm.id) || (detached && detached.vm.id !== record.vm.id)) {
      throw new KernelHttpError(404, "not_found", `Process ${processId} not found for browser ${record.vm.id}`);
    }
    if (!interactive && !detached) throw new KernelHttpError(404, "not_found", `Process ${processId} is not known to this proxy process`);
    this.trackStreamingResponse(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    if (interactive) {
      let nextSequence = interactive.output[0]?.sequence ?? interactive.nextOutputSequence;
      while (!res.destroyed) {
        for (const item of interactive.output) {
          if (item.sequence < nextSequence) continue;
          res.write(`data: ${JSON.stringify({ stream: "stdout", data_b64: item.data.toString("base64") })}\n\n`);
          nextSequence = item.sequence + 1;
        }
        if (interactive.state === "exited") {
          res.write(`data: ${JSON.stringify({ event: "exit", exit_code: interactive.exitCode ?? 0 })}\n\n`);
          res.end();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }
    if (detached) {
      let stdoutOffset = 0;
      let stderrOffset = 0;
      while (!res.destroyed) {
        const run = await detached.vm.getRun(detached.runId);
        const stdout = Buffer.from(run.stdoutBytes || new Uint8Array());
        const stderr = Buffer.from(run.stderrBytes || new Uint8Array());
        // Arker exposes cumulative run output. Emit only each newly observed
        // suffix so long-running processes behave like Kernel stdout streams.
        if (stdout.length < stdoutOffset) stdoutOffset = 0;
        if (stderr.length < stderrOffset) stderrOffset = 0;
        if (stdout.length > stdoutOffset) {
          res.write(`data: ${JSON.stringify({ stream: "stdout", data_b64: stdout.subarray(stdoutOffset).toString("base64") })}\n\n`);
          stdoutOffset = stdout.length;
        }
        if (stderr.length > stderrOffset) {
          res.write(`data: ${JSON.stringify({ stream: "stderr", data_b64: stderr.subarray(stderrOffset).toString("base64") })}\n\n`);
          stderrOffset = stderr.length;
        }
        if (run.state === "running") { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
        res.write(`data: ${JSON.stringify({ event: "exit", exit_code: run.exit_code ?? 1 })}\n\n`);
        await this.releaseDetachedSession(detached);
        res.end();
        return;
      }
      return;
    }
  }

  private async filesystem(req: IncomingMessage, res: ServerResponse, url: URL, id: string, action: string): Promise<void> {
    const record = await this.loadRecord(id);
    this.touch(record);
    const vm = record.vm;
    return this.withVmPinned(vm, async () => {
    if (action === "upload" && req.method === "POST") {
      const form = await this.multipart(req);
      const files = new Map<string, { dest?: string; data?: Buffer }>();
      const parts: Array<[string, FormDataEntryValue]> = [];
      form.forEach((value, name) => parts.push([name, value]));
      for (const [name, value] of parts) {
        const index = name.match(/files(?:\[|\.)(\d+)/)?.[1] ?? "0";
        const entry = files.get(index) ?? {};
        if (typeof value === "string" && name.includes("dest_path")) entry.dest = value;
        else if (typeof value !== "string" && name.includes("file")) entry.data = Buffer.from(await value.arrayBuffer());
        files.set(index, entry);
      }
      if (files.size === 0) throw new KernelHttpError(422, "validation_error", "files are required");
      for (const file of files.values()) {
        if (!file.dest || !file.data) throw new KernelHttpError(422, "validation_error", "each upload needs dest_path and file");
        const path = assertPath(file.dest, "dest_path");
        await vm.sync(path, file.data);
        this.emitFilesystemEvent(vm.id, path, "WRITE", false);
      }
      return sendEmpty(res, 204);
    }
    if (action === "upload_zip" && req.method === "POST") {
      const form = await this.multipart(req);
      let destination: string | undefined;
      let archive: Buffer | undefined;
      const parts: Array<[string, FormDataEntryValue]> = [];
      form.forEach((value, name) => parts.push([name, value]));
      for (const [name, value] of parts) {
        if (typeof value === "string" && name.includes("dest_path")) destination = value;
        else if (typeof value !== "string" && name.includes("zip_file")) archive = Buffer.from(await value.arrayBuffer());
      }
      if (!destination || !archive) throw new KernelHttpError(422, "validation_error", "dest_path and zip_file are required");
      const dest = assertPath(destination, "dest_path");
      const remote = `/tmp/arker-kernel-upload-${randomUUID()}.zip`;
      await vm.sync(remote, archive);
      const code = "import os,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); d=os.path.realpath(sys.argv[2]); os.makedirs(d,exist_ok=True); members=z.infolist();\nfor m in members:\n p=os.path.realpath(os.path.join(d,m.filename));\n if p!=d and not p.startswith(d+os.sep): raise ValueError('unsafe zip member: '+m.filename)\nz.extractall(d)";
      try {
        await this.runChecked(vm, `python3 -c ${shellQuote(code)} ${shellQuote(remote)} ${shellQuote(dest)}`);
      } finally {
        await this.runChecked(vm, `rm -f ${shellQuote(remote)}`).catch(() => {});
      }
      this.emitFilesystemEvent(vm.id, dest, "CREATE", true);
      return sendEmpty(res, 204);
    }
    if (action === "read_file" && req.method === "GET") {
      return sendBinary(res, 200, await vm.sync(assertPath(url.searchParams.get("path"))));
    }
    if (action === "write_file" && req.method === "PUT") {
      const path = assertPath(url.searchParams.get("path"));
      const requestedMode = url.searchParams.get("mode");
      const mode = requestedMode === null ? "0644" : fileMode(requestedMode);
      const body = await readBody(req);
      await vm.sync(path, body);
      await this.runChecked(vm, `chmod -- ${shellQuote(mode)} ${shellQuote(path)}`);
      this.emitFilesystemEvent(vm.id, path, "WRITE", false);
      return sendEmpty(res, 204);
    }
    if ((action === "file_info" || action === "list_files") && req.method === "GET") {
      const path = assertPath(url.searchParams.get("path"));
      const python = action === "file_info"
        ? "import json,os,stat,sys,datetime; p=sys.argv[1]; s=os.stat(p); print(json.dumps({'is_dir':stat.S_ISDIR(s.st_mode),'mod_time':datetime.datetime.fromtimestamp(s.st_mtime,datetime.timezone.utc).isoformat().replace('+00:00','Z'),'mode':stat.filemode(s.st_mode),'name':os.path.basename(p.rstrip('/')) or '/','path':p,'size_bytes':0 if stat.S_ISDIR(s.st_mode) else s.st_size}))"
        : "import json,os,stat,sys,datetime; p=sys.argv[1]; out=[]\nfor n in sorted(os.listdir(p)):\n q=os.path.join(p,n); s=os.stat(q); out.append({'is_dir':stat.S_ISDIR(s.st_mode),'mod_time':datetime.datetime.fromtimestamp(s.st_mtime,datetime.timezone.utc).isoformat().replace('+00:00','Z'),'mode':stat.filemode(s.st_mode),'name':n,'path':q,'size_bytes':0 if stat.S_ISDIR(s.st_mode) else s.st_size})\nprint(json.dumps(out))";
      const result = await this.runChecked(vm, `python3 -c ${shellQuote(python)} ${shellQuote(path)}`);
      return sendJson(res, 200, JSON.parse(runText(result, "stdout")));
    }
    if (["create_directory", "delete_directory", "delete_file", "move", "set_file_permissions"].includes(action) && req.method === "PUT") {
      const body = await readJson(req);
      let command: string;
      if (action === "create_directory") {
        const path = assertPath(body.path);
        const mode = body.mode === undefined ? "0755" : fileMode(body.mode);
        command = `mkdir -p ${shellQuote(path)} && chmod -- ${shellQuote(mode)} ${shellQuote(path)}`;
      }
      else if (action === "delete_directory") command = `rm -rf -- ${shellQuote(assertPath(body.path))}`;
      else if (action === "delete_file") command = `rm -f -- ${shellQuote(assertPath(body.path))}`;
      else if (action === "move") command = `mv -- ${shellQuote(assertPath(body.src_path, "src_path"))} ${shellQuote(assertPath(body.dest_path, "dest_path"))}`;
      else {
        const path = assertPath(body.path);
        const mode = fileMode(body.mode);
        const owner = body.owner === undefined ? "" : unixIdentity(body.owner, "owner");
        const group = body.group === undefined ? "" : unixIdentity(body.group, "group");
        const commands = [`chmod -- ${shellQuote(mode)} ${shellQuote(path)}`];
        if (owner || group) commands.push(`chown -- ${shellQuote(`${owner}${group ? `:${group}` : ""}`)} ${shellQuote(path)}`);
        command = commands.join(" && ");
      }
      await this.runChecked(vm, command);
      if (action === "create_directory") this.emitFilesystemEvent(vm.id, assertPath(body.path), "CREATE", true);
      else if (action === "delete_directory") this.emitFilesystemEvent(vm.id, assertPath(body.path), "DELETE", true);
      else if (action === "delete_file") this.emitFilesystemEvent(vm.id, assertPath(body.path), "DELETE", false);
      else if (action === "move") this.emitFilesystemEvent(vm.id, assertPath(body.dest_path, "dest_path"), "RENAME");
      return sendEmpty(res, 204);
    }
    if (action === "download_dir_zip" && req.method === "GET") {
      const path = assertPath(url.searchParams.get("path"));
      const remote = `/tmp/arker-kernel-${randomUUID()}.zip`;
      const code = "import os,sys,zipfile; p=sys.argv[1]; z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); root=os.path.dirname(p.rstrip('/'));\nfor d,_,fs in os.walk(p):\n for f in fs:\n  q=os.path.join(d,f); z.write(q,os.path.relpath(q,root))\nz.close()";
      try {
        await this.runChecked(vm, `python3 -c ${shellQuote(code)} ${shellQuote(path)} ${shellQuote(remote)}`);
        return sendBinary(res, 200, await vm.sync(remote), "application/zip");
      } finally {
        await this.runChecked(vm, `rm -f ${shellQuote(remote)}`).catch(() => undefined);
      }
    }
    throw new KernelHttpError(501, "unsupported_operation", `Kernel filesystem operation ${action} is not implemented`);
    });
  }

  private async multipart(req: IncomingMessage): Promise<FormData> {
    if (!contentType(req).startsWith("multipart/form-data")) throw new KernelHttpError(415, "unsupported_media_type", "multipart/form-data is required");
    const body = await readBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value != null) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    return new Request("http://kernel-proxy.local", { method: "POST", headers, body: body as unknown as BodyInit }).formData();
  }

  private async watchStart(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const body = await readJson(req);
    const path = assertPath(body.path);
    if (body.recursive !== undefined && typeof body.recursive !== "boolean") {
      throw new KernelHttpError(422, "validation_error", "recursive must be a boolean");
    }
    const recursive = body.recursive !== false;
    const watchId = randomUUID();
    const watchRoot = `/run/arker-kernel/watch-${watchId}`;
    await this.runChecked(record.vm, `test -d ${shellQuote(path)}`);
    const watch: FilesystemWatch = {
      vm: record.vm,
      vmId: record.vm.id,
      path: path.replace(/\/$/, "") || "/",
      recursive,
      events: [],
      nextSequence: 0,
      eventPath: `${watchRoot}.events`,
      pidPath: `${watchRoot}.pid`,
      byteOffset: 0,
      polling: false,
      lineBuffer: "",
      closed: false,
    };
    this.filesystemWatches.set(watchId, watch);
    try {
      if (!this.options.skipSetup) await this.startJournalWatchBackend(watch);
    } catch (error) {
      this.filesystemWatches.delete(watchId);
      await this.stopWatchBackend(watch);
      throw error;
    }
    sendJson(res, 201, { watch_id: watchId });
  }

  private async startJournalWatchBackend(watch: FilesystemWatch): Promise<void> {
    await this.withVmPinned(watch.vm, async () => {
      const recursive = watch.recursive ? "--recursive" : "";
      await watch.vm.sync(watch.eventPath, "");
      const inner = [
        `echo $$ > ${shellQuote(watch.pidPath)}`,
        `exec stdbuf -oL -eL inotifywait --monitor ${recursive} --event create,modify,close_write,attrib,delete,move --format '%e %w%f' -- ${shellQuote(watch.path)} >> ${shellQuote(watch.eventPath)} 2>/dev/null`,
      ].join("; ");
      try {
        await this.runChecked(watch.vm, `setsid -f /bin/bash -lc ${shellQuote(inner)}`, 20);
        await this.runChecked(
          watch.vm,
          `for _ in $(seq 1 50); do test -s ${shellQuote(watch.pidPath)} && kill -0 "$(cat ${shellQuote(watch.pidPath)})" 2>/dev/null && exit 0; sleep 0.1; done; exit 1`,
          10,
        );
        watch.pollTimer = setInterval(() => void this.pollWatchBackend(watch), 250);
        watch.pollTimer.unref?.();
      } catch (error) {
        throw new KernelHttpError(502, "watch_start_failed", error instanceof Error ? error.message : String(error));
      }
    });
  }

  private consumeWatchData(watch: FilesystemWatch, data: Uint8Array): void {
    watch.lineBuffer += Buffer.from(data).toString("utf8").replace(/\r/g, "");
    const lines = watch.lineBuffer.split("\n");
    watch.lineBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      const separator = line.indexOf(" ");
      if (separator < 0) continue;
      const flags = new Set(line.slice(0, separator).split(","));
      const path = line.slice(separator + 1);
      if (!path.startsWith("/")) continue;
      const type = flags.has("MOVED_FROM") || flags.has("MOVED_TO") || flags.has("MOVE")
        ? "RENAME"
        : flags.has("CREATE") ? "CREATE"
        : flags.has("DELETE") || flags.has("DELETE_SELF") ? "DELETE"
        : "WRITE";
      this.enqueueFilesystemEvent(watch, path, type, flags.has("ISDIR"));
    }
  }

  private async pollWatchBackend(watch: FilesystemWatch): Promise<void> {
    if (watch.closed || watch.polling) return;
    watch.polling = true;
    try {
      const journal = Buffer.from(await watch.vm.sync(watch.eventPath));
      if (journal.length < watch.byteOffset) {
        watch.byteOffset = 0;
        watch.lineBuffer = "";
      }
      if (journal.length > watch.byteOffset) {
        this.consumeWatchData(watch, journal.subarray(watch.byteOffset));
        watch.byteOffset = journal.length;
      }
    } catch {
      // A transient sync failure is retried on the next poll.
    } finally {
      watch.polling = false;
    }
  }

  private enqueueFilesystemEvent(watch: FilesystemWatch, path: string, type: "CREATE" | "WRITE" | "DELETE" | "RENAME", isDir?: boolean): void {
    watch.events.push({
      sequence: watch.nextSequence++,
      data: { type, path, name: path.split("/").filter(Boolean).pop() || "/", ...(isDir == null ? {} : { is_dir: isDir }) },
    });
    if (watch.events.length > MAX_FILESYSTEM_WATCH_EVENTS) watch.events.shift();
  }

  private async stopWatchBackend(watch: FilesystemWatch): Promise<void> {
    watch.closed = true;
    if (watch.pollTimer) clearInterval(watch.pollTimer);
    watch.pollTimer = undefined;
    await this.runChecked(
      watch.vm,
      `if test -s ${shellQuote(watch.pidPath)}; then kill -TERM -- "$(cat ${shellQuote(watch.pidPath)})" 2>/dev/null || true; fi; rm -f -- ${shellQuote(watch.pidPath)} ${shellQuote(watch.eventPath)}`,
      20,
    ).catch(() => undefined);
  }

  private async watchEvents(res: ServerResponse, id: string, watchId: string): Promise<void> {
    const record = await this.loadRecord(id);
    const watch = this.filesystemWatches.get(watchId);
    if (!watch || watch.vmId !== record.vm.id) throw new KernelHttpError(404, "not_found", `Watch ${watchId} not found`);
    this.trackStreamingResponse(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    let nextSequence = watch.events[0]?.sequence ?? watch.nextSequence;
    while (!res.destroyed && this.filesystemWatches.has(watchId) && !watch.closed) {
      for (const item of watch.events) {
        if (item.sequence < nextSequence) continue;
        res.write(`data: ${JSON.stringify(item.data)}\n\n`);
        nextSequence = item.sequence + 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!res.writableEnded) res.end();
  }

  private async watchStop(res: ServerResponse, id: string, watchId: string): Promise<void> {
    const record = await this.loadRecord(id);
    const watch = this.filesystemWatches.get(watchId);
    if (!watch || watch.vmId !== record.vm.id) throw new KernelHttpError(404, "not_found", `Watch ${watchId} not found`);
    await this.stopWatchBackend(watch);
    this.filesystemWatches.delete(watchId);
    sendEmpty(res, 204);
  }

  private emitFilesystemEvent(vmId: string, path: string, type: "CREATE" | "WRITE" | "DELETE" | "RENAME", isDir?: boolean): void {
    for (const watch of this.filesystemWatches.values()) {
      if (watch.vmId !== vmId) continue;
      if (watch.pollTimer) continue;
      const relative = watch.path === "/"
        ? path.slice(1)
        : path.startsWith(`${watch.path}/`) ? path.slice(watch.path.length + 1) : "";
      if (!relative || (!watch.recursive && relative.includes("/"))) continue;
      this.enqueueFilesystemEvent(watch, path, type, isDir);
    }
  }

  private async playwright(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const body = await readJson(req);
    if (typeof body.code !== "string") throw new KernelHttpError(422, "validation_error", "code is required");
    const timeoutSeconds = body.timeout_sec === undefined ? 60 : finiteNumber(body.timeout_sec, "timeout_sec");
    if (timeoutSeconds <= 0 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new KernelHttpError(422, "validation_error", `timeout_sec must be greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`);
    }
    sendJson(res, 200, await this.executePlaywright(record, body.code, timeoutSeconds));
  }

  private async executePlaywright(record: BrowserRecord, code: string, timeoutSeconds = 60): Promise<Record<string, unknown>> {
    const requestBody = JSON.stringify({ code, timeout_ms: Math.max(1_000, timeoutSeconds * 1_000) });
    if (!this.options.skipSetup) {
      try {
        const response = await this.runnerFetch(record, "/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        }, Math.max(2_000, (timeoutSeconds + 5) * 1_000));
        return await response.json() as Record<string, unknown>;
      } catch {
        // Sessions created before the authenticated runner port was introduced,
        // and customized setup scripts that keep it loopback-only, retain the
        // filesystem/guest-command path below.
      }
    }
    return this.withVmPinned(record.vm, async () => {
      const nonce = randomUUID();
      const requestPath = `/tmp/arker-kernel-playwright-${nonce}.request.json`;
      const outputPath = `/tmp/arker-kernel-playwright-${nonce}.json`;
      await record.vm.sync(requestPath, JSON.stringify({ code, timeout_ms: Math.max(1_000, timeoutSeconds * 1_000) }));
      const execute = `curl -fsS --max-time ${Math.max(2, timeoutSeconds + 5)} -H 'content-type: application/json' --data-binary @${shellQuote(requestPath)} -o ${shellQuote(outputPath)} http://127.0.0.1:9230/execute`;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await this.runChecked(record.vm, execute, timeoutSeconds + 10);
            return JSON.parse(new TextDecoder().decode(await record.vm.sync(outputPath))) as Record<string, unknown>;
          } catch (error) {
            if (attempt === 1) throw error;
            await this.withVmControl(record.vm.id, () => this.runServiceWithRepair(record, "/opt/arker-kernel/start-playwright-runner.sh", 45));
          }
        }
        throw new KernelHttpError(502, "execution_failed", "Playwright execution did not produce a result");
      } finally {
        await this.runChecked(record.vm, `rm -f ${shellQuote(requestPath)} ${shellQuote(outputPath)}`, 20).catch(() => undefined);
      }
    });
  }

  private async runnerFetch(record: BrowserRecord, path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    return this.withVmPinned(record.vm, async () => {
      const headers = new Headers(init.headers);
      if (this.forwardApiKey) headers.set("authorization", `Bearer ${this.forwardApiKey}`);
      const response = await fetch(`https://${insertPort(record.metadata.hostname, 9230)}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const responseBody = await response.arrayBuffer();
      if (!response.ok) throw new Error(`runner ${path} returned HTTP ${response.status}`);
      // Consume the authenticated guest response while the VM is pinned. A
      // detached Response body could otherwise continue reading after release.
      return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
  }

  private async browserCurl(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const body = await readJson(req);
    if (body.response_encoding !== undefined && !["utf8", "base64"].includes(String(body.response_encoding))) {
      throw new KernelHttpError(422, "validation_error", "response_encoding must be utf8 or base64");
    }
    const response = await this.browserHttp(record, body);
    sendJson(res, 200, {
      status: response.status,
      headers: response.headers,
      body: body.response_encoding === "base64" ? response.body.toString("base64") : response.body.toString("utf8"),
      duration_ms: response.durationMs,
    });
  }

  private async browserHttp(record: BrowserRecord, body: Record<string, unknown>): Promise<{ status: number; headers: Record<string, string[]>; body: Buffer; durationMs: number }> {
    if (typeof body.url !== "string") throw new KernelHttpError(422, "validation_error", "url must be http or https");
    try {
      const parsed = new URL(body.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new KernelHttpError(422, "validation_error", "url must be a valid http or https URL");
    }
    const timeoutMs = body.timeout_ms === undefined ? 30_000 : finiteNumber(body.timeout_ms, "timeout_ms");
    if (timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new KernelHttpError(422, "validation_error", `timeout_ms must be greater than 0 and at most ${MAX_TIMEOUT_MS}`);
    }
    const method = String(body.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) {
      throw new KernelHttpError(422, "validation_error", "method is not supported");
    }
    if (body.body !== undefined && body.body !== null && typeof body.body !== "string") throw new KernelHttpError(422, "validation_error", "body must be a string");
    if (body.body !== undefined && body.body !== null && body.body_b64 !== undefined && body.body_b64 !== null) {
      throw new KernelHttpError(422, "validation_error", "body and body_b64 cannot both be provided");
    }
    const headers = body.headers == null ? {} : asObject(body.headers);
    if (Object.values(headers).some((value) => typeof value !== "string")) throw new KernelHttpError(422, "validation_error", "header values must be strings");
    let bodyBase64: string | null = null;
    if (body.body_b64 !== undefined && body.body_b64 !== null) {
      bodyBase64 = decodeBase64(body.body_b64, "body_b64").toString("base64");
    }
    const request = {
      url: body.url,
      method,
      headers,
      body: body.body == null ? null : String(body.body),
      body_b64: bodyBase64,
    };
    const code = `const q=${JSON.stringify(request)};\nconst target=new URL(q.url);\nconst worker=await context.newPage();\ntry {\n await worker.goto(target.origin,{waitUntil:"domcontentloaded",timeout:${Math.max(1, timeoutMs)}}).catch(()=>{});\n const started=Date.now();\n const value=await worker.evaluate(async (request)=>{\n  let requestBody=request.body; if(request.body_b64!==null){const binary=atob(request.body_b64); requestBody=Uint8Array.from(binary,c=>c.charCodeAt(0));}\n  const response=await fetch(request.url,{method:request.method,headers:request.headers,body:["GET","HEAD"].includes(request.method)?undefined:requestBody,credentials:"include"});\n  const bytes=new Uint8Array(await response.arrayBuffer()); let binary=""; for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));\n  const headers={}; for(const [key,value] of response.headers.entries()) (headers[key] ||= []).push(value);\n  return {status:response.status,headers,body_b64:btoa(binary)};\n },q);\n return {...value,duration_ms:Date.now()-started};\n} finally { await worker.close(); }`;
    const payload = await this.executePlaywright(record, code, Math.ceil(timeoutMs / 1000) + 10);
    if (!payload.success) throw new KernelHttpError(502, "browser_request_failed", String(payload.error || "Chrome request failed"));
    const result = asObject(payload.result);
    return {
      status: Number(result.status),
      headers: (result.headers || {}) as Record<string, string[]>,
      body: Buffer.from(String(result.body_b64 || ""), "base64"),
      durationMs: Number(result.duration_ms || 0),
    };
  }

  private async computer(req: IncomingMessage, res: ServerResponse, id: string, action: string): Promise<void> {
    const record = await this.loadRecord(id);
    const body = await readJson(req);
    if (action === "batch") {
      const actions = body.actions as Array<Record<string, unknown>>;
      if (!Array.isArray(actions)) throw new KernelHttpError(422, "validation_error", "actions must be an array");
      for (const value of actions) {
        const item = asObject(value);
        if (typeof item.type !== "string" || !["click_mouse", "move_mouse", "type_text", "press_key", "scroll", "drag_mouse", "set_cursor", "sleep"].includes(item.type)) {
          throw new KernelHttpError(422, "validation_error", "batch action type is invalid");
        }
        const type = item.type;
        if (type === "sleep") {
          const duration = finiteNumber(asObject(item.sleep).duration_ms, "sleep duration_ms");
          if (duration < 0) throw new KernelHttpError(422, "validation_error", "sleep duration_ms must be non-negative");
          await new Promise((resolve) => setTimeout(resolve, duration));
        }
        else await this.computerAction(record, type === "type_text" ? "type" : type === "set_cursor" ? "cursor" : type, asObject(item[type]));
      }
      return sendEmpty(res, 204);
    }
    const result = await this.computerAction(record, action, body);
    if (Buffer.isBuffer(result)) return sendBinary(res, 200, result, "image/png");
    if (result !== undefined) return sendJson(res, 200, result);
    sendEmpty(res, 204);
  }

  private async computerAction(record: BrowserRecord, action: string, body: Record<string, unknown>): Promise<Record<string, unknown> | Buffer | undefined> {
    if (action === "get_mouse_position") return record.metadata.mouse ?? { x: 0, y: 0 };
    if (action === "clipboard/read") return { text: record.metadata.clipboard ?? "" };
    if (action === "clipboard/write") {
      if (typeof body.text !== "string") throw new KernelHttpError(422, "validation_error", "text must be a string");
      record.metadata.clipboard = body.text;
      await this.persist(record);
      await this.executePlaywright(record, `await context.grantPermissions(["clipboard-read","clipboard-write"]).catch(()=>{}); await page.evaluate(async text=>navigator.clipboard?.writeText(text),${JSON.stringify(record.metadata.clipboard)}).catch(()=>{}); return true;`);
      return;
    }
    if (action === "screenshot") {
      const region = body.region && typeof body.region === "object" ? body.region as Record<string, unknown> : undefined;
      const clip = region ? {
        x: finiteNumber(region.x, "region.x"),
        y: finiteNumber(region.y, "region.y"),
        width: finiteNumber(region.width, "region.width"),
        height: finiteNumber(region.height, "region.height"),
      } : undefined;
      if (clip && (clip.width <= 0 || clip.height <= 0)) throw new KernelHttpError(422, "validation_error", "region width and height must be positive");
      const options = clip ? { type: "png", clip } : { type: "png" };
      const payload = await this.executePlaywright(record, `return (await page.screenshot(${JSON.stringify(options)})).toString("base64");`);
      if (!payload.success) throw new KernelHttpError(502, "computer_action_failed", String(payload.error || "screenshot failed"));
      return Buffer.from(String(payload.result || ""), "base64");
    }
    if (action === "cursor") {
      if (typeof body.hidden !== "boolean") throw new KernelHttpError(422, "validation_error", "hidden must be a boolean");
      record.metadata.cursorHidden = body.hidden;
      await this.persist(record);
      const value = record.metadata.cursorHidden ? "none" : "auto";
      await this.executePlaywright(record, `await page.addStyleTag({content:${JSON.stringify(`*{cursor:${value} !important}`)}}); return true;`);
      return { ok: true };
    }
    const keyMap: Record<string, string> = {
      Return: "Enter", KP_Enter: "Enter", Ctrl: "Control", Esc: "Escape", BackSpace: "Backspace", Del: "Delete", Super: "Meta",
      Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Prior: "PageUp", Next: "PageDown", space: " ",
    };
    const mapKey = (key: unknown) => String(key).split("+").map((part) => keyMap[part] || part).join("+");
    if (body.hold_keys !== undefined && (!Array.isArray(body.hold_keys) || body.hold_keys.some((key) => typeof key !== "string"))) {
      throw new KernelHttpError(422, "validation_error", "hold_keys must be an array of strings");
    }
    const holdKeys = ((body.hold_keys as unknown[]) || [])
      .flatMap((key) => String(key).split("+"))
      .map((key) => keyMap[key] || key);
    const withHeldKeys = (operation: string): string => {
      const down = holdKeys.map((key) => `await page.keyboard.down(${JSON.stringify(key)});`).join(" ");
      const up = [...holdKeys].reverse().map((key) => `await page.keyboard.up(${JSON.stringify(key)});`).join(" ");
      return `${down} try { ${operation} } finally { ${up} } return true;`;
    };
    let code: string;
    if (action === "move_mouse") {
      const start = record.metadata.mouse ?? { x: 0, y: 0 };
      const target = { x: finiteNumber(body.x, "x"), y: finiteNumber(body.y, "y") };
      const distance = Math.hypot(target.x - start.x, target.y - start.y);
      if (body.smooth !== undefined && typeof body.smooth !== "boolean") throw new KernelHttpError(422, "validation_error", "smooth must be a boolean");
      const duration = body.smooth
        ? finiteNumber(body.duration_ms ?? Math.min(1_000, Math.max(100, distance * 2)), "duration_ms")
        : 0;
      if (duration < 0) throw new KernelHttpError(422, "validation_error", "duration_ms must be non-negative");
      const steps = body.smooth ? Math.max(2, Math.ceil(duration / 16)) : 1;
      const operation = steps === 1
        ? `await page.mouse.move(${target.x},${target.y});`
        : `const a=${JSON.stringify(start)},b=${JSON.stringify(target)},steps=${steps},delay=${duration / steps}; for(let i=1;i<=steps;i++){const t=i/steps; await page.mouse.move(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t); if(delay) await new Promise(r=>setTimeout(r,delay));}`;
      record.metadata.mouse = target;
      code = withHeldKeys(operation);
    } else if (action === "click_mouse") {
      record.metadata.mouse = { x: finiteNumber(body.x, "x"), y: finiteNumber(body.y, "y") };
      const button = String(body.button || "left");
      if (!["left", "right", "middle", "back", "forward"].includes(button)) throw new KernelHttpError(422, "validation_error", "button is invalid");
      const options = { button, clickCount: 1 };
      const clicks = finiteNumber(body.num_clicks ?? 1, "num_clicks");
      if (!Number.isInteger(clicks) || clicks < 1) throw new KernelHttpError(422, "validation_error", "num_clicks must be a positive integer");
      const clickType = String(body.click_type || "click");
      if (!["click", "down", "up"].includes(clickType)) throw new KernelHttpError(422, "validation_error", "click_type is invalid");
      let operation: string;
      if (button === "back" || button === "forward") {
        operation = `await page.${button === "back" ? "goBack" : "goForward"}({waitUntil:"domcontentloaded"}).catch(()=>{});`;
      } else if (clickType === "click") {
        operation = `for(let i=0;i<${clicks};i++) await page.mouse.click(${record.metadata.mouse.x},${record.metadata.mouse.y},${JSON.stringify(options)});`;
      } else {
        operation = `await page.mouse.move(${record.metadata.mouse.x},${record.metadata.mouse.y}); await page.mouse.${clickType === "down" ? "down" : "up"}(${JSON.stringify({ button })});`;
      }
      code = withHeldKeys(operation);
    } else if (action === "type") {
      if (typeof body.text !== "string") throw new KernelHttpError(422, "validation_error", "text must be a string");
      const delay = finiteNumber(body.delay ?? 0, "delay");
      if (delay < 0) throw new KernelHttpError(422, "validation_error", "delay must be non-negative");
      code = `await page.keyboard.type(${JSON.stringify(body.text)},{delay:${delay}}); return true;`;
    } else if (action === "press_key") {
      if (!Array.isArray(body.keys) || body.keys.some((key) => typeof key !== "string")) throw new KernelHttpError(422, "validation_error", "keys must be an array of strings");
      const keys = ((body.keys as unknown[]) || []).map(mapKey);
      const delay = finiteNumber(body.duration ?? 0, "duration");
      if (delay < 0) throw new KernelHttpError(422, "validation_error", "duration must be non-negative");
      code = withHeldKeys(keys.map((key) => `await page.keyboard.press(${JSON.stringify(key)},{delay:${delay}});`).join(" "));
    } else if (action === "scroll") {
      record.metadata.mouse = { x: finiteNumber(body.x, "x"), y: finiteNumber(body.y, "y") };
      const deltaX = finiteNumber(body.delta_x ?? 0, "delta_x");
      const deltaY = finiteNumber(body.delta_y ?? 0, "delta_y");
      code = withHeldKeys(`await page.mouse.move(${record.metadata.mouse.x},${record.metadata.mouse.y}); await page.mouse.wheel(${deltaX * 100},${deltaY * 100});`);
    } else if (action === "drag_mouse") {
      const path = body.path as number[][];
      if (!Array.isArray(path) || path.length < 2 || path.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) {
        throw new KernelHttpError(422, "validation_error", "drag path needs at least two finite [x, y] points");
      }
      const button = body.button || "left";
      if (!["left", "right", "middle"].includes(String(button))) throw new KernelHttpError(422, "validation_error", "button is invalid");
      if (body.smooth !== undefined && typeof body.smooth !== "boolean") throw new KernelHttpError(422, "validation_error", "smooth must be a boolean");
      const totalDistance = path.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0]! - path[index]![0]!, point[1]! - path[index]![1]!), 0);
      const smoothDuration = body.smooth
        ? finiteNumber(body.duration_ms ?? Math.min(2_000, Math.max(150, totalDistance * 2)), "duration_ms")
        : 0;
      if (smoothDuration < 0) throw new KernelHttpError(422, "validation_error", "duration_ms must be non-negative");
      const steps = body.smooth
        ? Math.max(2, Math.ceil(smoothDuration / (16 * (path.length - 1))))
        : finiteNumber(body.steps_per_segment ?? 1, "steps_per_segment");
      if (!Number.isInteger(steps) || steps < 1) throw new KernelHttpError(422, "validation_error", "steps_per_segment must be a positive integer");
      const moves = (path.length - 1) * steps;
      const stepDelay = body.smooth
        ? smoothDuration / moves
        : finiteNumber(body.step_delay_ms ?? 0, "step_delay_ms");
      if (stepDelay < 0) throw new KernelHttpError(422, "validation_error", "step_delay_ms must be non-negative");
      const initialDelay = finiteNumber(body.delay ?? 0, "delay");
      if (initialDelay < 0) throw new KernelHttpError(422, "validation_error", "delay must be non-negative");
      const operation = `const path=${JSON.stringify(path)},steps=${steps},delay=${stepDelay},smooth=${Boolean(body.smooth)}; await page.mouse.move(path[0][0],path[0][1]); await page.mouse.down({button:${JSON.stringify(button)}}); try { await new Promise(r=>setTimeout(r,${initialDelay})); for(let n=1;n<path.length;n++){const a=path[n-1],b=path[n],cx=(a[0]+b[0])/2-(b[1]-a[1])*.1,cy=(a[1]+b[1])/2+(b[0]-a[0])*.1; for(let i=1;i<=steps;i++){const t=i/steps,u=1-t,x=smooth?u*u*a[0]+2*u*t*cx+t*t*b[0]:a[0]+(b[0]-a[0])*t,y=smooth?u*u*a[1]+2*u*t*cy+t*t*b[1]:a[1]+(b[1]-a[1])*t; await page.mouse.move(x,y); if(delay) await new Promise(r=>setTimeout(r,delay));}} } finally { await page.mouse.up({button:${JSON.stringify(button)}}); }`;
      code = withHeldKeys(operation);
      const last = path[path.length - 1]!;
      record.metadata.mouse = { x: Number(last[0]), y: Number(last[1]) };
    } else throw new KernelHttpError(404, "not_found", `Unknown computer action ${action}`);
    const payload = await this.executePlaywright(record, code);
    if (!payload.success) throw new KernelHttpError(502, "computer_action_failed", String(payload.error || `${action} failed`));
    return;
  }

  private async logs(res: ServerResponse, url: URL, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const source = url.searchParams.get("source");
    const follow = url.searchParams.get("follow") === "true";
    let path: string;
    if (source === "path") path = assertPath(url.searchParams.get("path"));
    else if (source === "supervisor") {
      const process = url.searchParams.get("supervisor_process");
      if (!process) throw new KernelHttpError(422, "validation_error", "supervisor_process is required for supervisor logs");
      if (!["browser", "cloakbrowser"].includes(process)) {
        throw new KernelHttpError(422, "unsupported_operation", `supervisor log process ${process} is not available`);
      }
      path = "/var/log/arker-kernel/browser.log";
    } else throw new KernelHttpError(422, "validation_error", "source must be path or supervisor");
    if (follow) return this.followLogs(res, record, path);
    const result = await this.runChecked(record.vm, `tail -n 1000 -- ${shellQuote(path)} 2>/dev/null || true`);
    this.trackStreamingResponse(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const message of runText(result, "stdout").split("\n")) {
      if (message) res.write(`data: ${JSON.stringify({ event: "log", message, timestamp: isoNow() })}\n\n`);
    }
    if (!follow) res.end();
  }

  private async followLogs(res: ServerResponse, record: BrowserRecord, path: string): Promise<void> {
    let snapshot = Buffer.alloc(0);
    try { snapshot = Buffer.from(await record.vm.sync(path)); } catch { /* tail -F waits for the path */ }
    let byteOffset = snapshot.length;
    let lineBuffer = "";
    const initialLines = snapshot.toString("utf8").replace(/\r/g, "").split("\n");
    if (initialLines.at(-1) === "") initialLines.pop();
    this.trackStreamingResponse(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    const writeLine = (message: string) => {
      if (message && !res.destroyed) res.write(`data: ${JSON.stringify({ event: "log", message, timestamp: isoNow() })}\n\n`);
    };
    for (const message of initialLines.slice(-1_000)) writeLine(message);
    let keepaliveAt = Date.now() + 15_000;
    while (!res.destroyed && this.cache.has(record.vm.id)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      let current: Buffer;
      try { current = Buffer.from(await record.vm.sync(path)); } catch { continue; }
      if (current.length < byteOffset) {
        byteOffset = 0;
        lineBuffer = "";
      }
      if (current.length > byteOffset) {
        lineBuffer += current.subarray(byteOffset).toString("utf8").replace(/\r/g, "");
        byteOffset = current.length;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const message of lines) writeLine(message);
        keepaliveAt = Date.now() + 15_000;
      } else if (Date.now() >= keepaliveAt) {
        res.write(": keepalive\n\n");
        keepaliveAt = Date.now() + 15_000;
      }
    }
    if (!res.writableEnded) res.end();
  }

  private async telemetrySnapshot(record: BrowserRecord): Promise<Array<{ seq: number; event: Record<string, unknown> }>> {
    if (!this.options.skipSetup) {
      try {
        const response = await this.runnerFetch(record, "/telemetry/events");
        const payload = await response.json() as { events?: unknown };
        return Array.isArray(payload.events)
          ? payload.events.filter((item): item is { seq: number; event: Record<string, unknown> } =>
            Boolean(item && typeof item === "object" && Number.isInteger((item as { seq?: unknown }).seq) &&
              (item as { event?: unknown }).event && typeof (item as { event?: unknown }).event === "object"))
          : [];
      } catch { /* fall through to the durable guest journal */ }
    }
    try {
        const text = new TextDecoder().decode(await record.vm.sync("/var/lib/arker-kernel/telemetry.jsonl"));
        return text.split("\n").filter(Boolean).flatMap((line) => {
          try {
            const item = JSON.parse(line) as { seq?: unknown; event?: unknown };
            return Number.isInteger(item.seq) && item.event && typeof item.event === "object"
              ? [{ seq: Number(item.seq), event: item.event as Record<string, unknown> }]
              : [];
          } catch { return []; }
        });
    } catch { return []; }
  }

  private telemetryBoundary(value: string | null, now: number): number | undefined {
    if (!value) return undefined;
    const duration = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
    if (duration) {
      const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
      return now - Number(duration[1]) * units[duration[2] as keyof typeof units];
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new KernelHttpError(422, "validation_error", "telemetry time bounds must be RFC 3339 timestamps or durations such as 5m");
    return parsed;
  }

  private async telemetryEvents(res: ServerResponse, url: URL, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
    const requestedOffset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0 || requestedLimit > 1_000 || !Number.isInteger(requestedOffset) || requestedOffset < 0) {
      throw new KernelHttpError(422, "validation_error", "telemetry limit must be 1..1000 and offset must be a non-negative integer");
    }
    const order = url.searchParams.get("order") ?? "asc";
    if (order !== "asc" && order !== "desc") throw new KernelHttpError(422, "validation_error", "telemetry order must be asc or desc");
    if (order === "desc" && url.searchParams.has("since")) throw new KernelHttpError(400, "validation_error", "telemetry order=desc cannot be combined with since");
    const categories = new Set([
      ...url.searchParams.getAll("category"),
      ...url.searchParams.getAll("category[]"),
    ].flatMap((value) => value.split(",")).filter(Boolean));
    const now = Date.now();
    const since = url.searchParams.has("offset") ? undefined : this.telemetryBoundary(url.searchParams.get("since") ?? "5m", now);
    const until = this.telemetryBoundary(url.searchParams.get("until"), now);
    const events = (await this.telemetrySnapshot(record)).filter((item) => {
      const timestamp = Number(item.event.ts || 0) / 1_000;
      return (since === undefined || timestamp >= since) && (until === undefined || timestamp < until);
    });
    events.sort((a, b) => order === "asc" ? a.seq - b.seq : b.seq - a.seq);
    // Kernel applies category filters within each raw archive page. A filtered
    // page can consequently be empty while X-Has-More remains true, and its
    // cursor advances by raw records rather than by returned records.
    const rawPage = events.slice(requestedOffset, requestedOffset + requestedLimit);
    const page = rawPage.filter((item) => categories.size === 0 || categories.has(String(item.event.category || "")));
    const nextOffset = requestedOffset + rawPage.length < events.length ? requestedOffset + rawPage.length : 0;
    res.setHeader("x-has-more", nextOffset > 0 ? "true" : "false");
    res.setHeader("x-next-offset", String(nextOffset));
    sendJson(res, 200, page);
  }

  private async telemetryStream(req: IncomingMessage, res: ServerResponse, url: URL, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    if (this.options.skipSetup) {
      this.trackStreamingResponse(res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end();
      return;
    }
    const lastEventId = Number(req.headers["last-event-id"]);
    const initial = await this.telemetrySnapshot(record);
    let nextSequence = Number.isInteger(lastEventId) && lastEventId >= 0
      ? lastEventId + 1
      : url.searchParams.get("replay") === "all" ? 0 : Math.max(0, ...initial.map((item) => item.seq)) + 1;
    this.trackStreamingResponse(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    let keepaliveAt = Date.now() + 15_000;
    while (!res.destroyed) {
      const events = await this.telemetrySnapshot(record);
      let wrote = false;
      for (const item of events) {
        if (item.seq < nextSequence) continue;
        res.write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);
        nextSequence = item.seq + 1;
        wrote = true;
      }
      if (wrote) keepaliveAt = Date.now() + 15_000;
      else if (Date.now() >= keepaliveAt) {
        res.write(": keepalive\n\n");
        keepaliveAt = Date.now() + 15_000;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async loadExtensions(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const form = await this.multipart(req);
    const entries = new Map<string, { name?: string; archive?: Buffer }>();
    const parts: Array<[string, FormDataEntryValue]> = [];
    form.forEach((value, name) => parts.push([name, value]));
    for (const [field, value] of parts) {
      const index = field.match(/extensions(?:\[|\.)(\d+)/)?.[1] ?? "0";
      const entry = entries.get(index) ?? {};
      if (typeof value === "string" && field.includes("name")) entry.name = value;
      else if (typeof value !== "string" && field.includes("zip_file")) entry.archive = Buffer.from(await value.arrayBuffer());
      entries.set(index, entry);
    }
    return this.withVmPinned(record.vm, async () => {
      const paths: string[] = [];
      for (const [index, entry] of entries) {
        if (!entry.archive) throw new KernelHttpError(422, "validation_error", "each extension needs zip_file");
        const safeName = (entry.name || `extension-${index}`).replace(/[^A-Za-z0-9_.-]/g, "-");
        const destination = `/opt/arker-kernel/extensions/${safeName}-${randomUUID().slice(0, 8)}`;
        const archive = `/tmp/arker-kernel-extension-${randomUUID()}.zip`;
        await record.vm.sync(archive, entry.archive);
        const code = "import os,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); d=os.path.realpath(sys.argv[2]); os.makedirs(d,exist_ok=True); members=z.infolist();\nfor m in members:\n p=os.path.realpath(os.path.join(d,m.filename));\n if p!=d and not p.startswith(d+os.sep): raise ValueError('unsafe zip member: '+m.filename)\nz.extractall(d)";
        try { await this.runChecked(record.vm, `python3 -c ${shellQuote(code)} ${shellQuote(archive)} ${shellQuote(destination)}`); }
        finally { await this.runChecked(record.vm, `rm -f ${shellQuote(archive)}`).catch(() => {}); }
        paths.push(destination);
      }
      if (paths.length === 0) throw new KernelHttpError(422, "validation_error", "extensions are required");
      const update = "import json,sys; p=sys.argv[1]; paths=sys.argv[2:]; q=json.load(open(p)); old=[x for x in q.get('browserArgs',[]) if not x.startswith('--load-extension=') and not x.startswith('--disable-extensions-except=')]; joined=','.join(paths); q['browserArgs']=old+['--disable-extensions-except='+joined,'--load-extension='+joined]; json.dump(q,open(p,'w'))";
      await this.runChecked(record.vm, `python3 -c ${shellQuote(update)} /opt/arker-kernel/config.json ${paths.map(shellQuote).join(" ")}`, 60);
      await this.withVmControl(record.vm.id, () => this.runServiceWithRepair(record, "/opt/arker-kernel/start-services.sh /opt/arker-kernel/config.json", 180));
      const discovery = await this.runChecked(record.vm, "curl -fsS --max-time 5 http://127.0.0.1:9222/json/version", 20);
      const cdp = new URL(JSON.parse(runText(discovery, "stdout")).webSocketDebuggerUrl);
      record.metadata.cdpPath = `${cdp.pathname}${cdp.search}`;
      const webdriver = await this.runChecked(record.vm, "cat /run/arker-kernel/webdriver.json", 20);
      const webdriverPayload = JSON.parse(runText(webdriver, "stdout"));
      const bidiUrl = new URL(webdriverPayload.value.capabilities.webSocketUrl);
      record.metadata.bidiPath = `${bidiUrl.pathname}${bidiUrl.search}`;
      await this.persist(record);
      sendEmpty(res, 204);
    });
  }

  private replayResponse(req: IncomingMessage, replayId: string, replay: BrowserReplay): Record<string, unknown> {
    return {
      replay_id: replayId,
      started_at: replay.startedAt,
      finished_at: replay.finishedAt ?? null,
    };
  }

  private async listReplays(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const values: Record<string, unknown>[] = [];
    for (const [replayId, replay] of this.browserReplays) if (replay.vm.id === record.vm.id) values.push(this.replayResponse(req, replayId, replay));
    sendJson(res, 200, values);
  }

  private async beginReplay(
    record: BrowserRecord,
    fps: number,
    maxDurationSeconds: number,
    recordAudio: boolean,
  ): Promise<{ replayId: string; replay: BrowserReplay }> {
    const replayId = randomUUID();
    const directory = `/tmp/arker-kernel-replay-${replayId}`;
    const outputPath = `${directory}/replay.mp4`;
    await this.runChecked(record.vm, `mkdir -p ${shellQuote(directory)}`);
    const replay: BrowserReplay = {
      vm: record.vm,
      directory,
      outputPath,
      recordAudio,
      ...(recordAudio ? {
        audioPath: `${directory}/audio.wav`,
        audioPidPath: `${directory}/audio.pid`,
      } : {}),
      fps,
      maxDurationSeconds,
      expiresAtMs: Date.now() + maxDurationSeconds * 1_000,
      startedAt: isoNow(),
      frame: 0,
    };
    this.browserReplays.set(replayId, replay);
    try {
      if (recordAudio) await this.startReplayAudio(replay);
      await this.captureReplayFrame(replay);
    } catch (error) {
      this.browserReplays.delete(replayId);
      await this.stopReplayAudio(replay).catch(() => undefined);
      await this.runChecked(record.vm, `rm -rf -- ${shellQuote(directory)}`, 20).catch(() => undefined);
      throw error;
    }
    replay.timer = setInterval(() => {
      if (!replay.capture) void this.captureReplayFrame(replay).catch(() => { if (replay.timer) clearInterval(replay.timer); replay.timer = undefined; });
    }, Math.max(50, Math.floor(1000 / fps)));
    replay.timer.unref?.();
    replay.maxTimer = setTimeout(() => {
      replay.maxTimer = undefined;
      void this.finishReplay(replayId, replay).catch(() => undefined);
    }, maxDurationSeconds * 1_000);
    replay.maxTimer.unref?.();
    return { replayId, replay };
  }

  private async startReplay(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.loadRecord(id);
    const body = await readJson(req);
    if (body.record_audio !== undefined && typeof body.record_audio !== "boolean") {
      throw new KernelHttpError(422, "validation_error", "record_audio must be a boolean");
    }
    const fps = body.framerate === undefined ? 10 : finiteNumber(body.framerate, "framerate");
    const maxSeconds = body.max_duration_in_seconds === undefined
      ? 600
      : finiteNumber(body.max_duration_in_seconds, "max_duration_in_seconds");
    if (fps <= 0 || fps > 20) throw new KernelHttpError(422, "validation_error", "framerate must be greater than 0 and at most 20 without GPU");
    if (maxSeconds <= 0 || maxSeconds > 3600) throw new KernelHttpError(422, "validation_error", "max_duration_in_seconds must be greater than 0 and at most 3600");
    if (record.metadata.headless) {
      throw new KernelHttpError(400, "unsupported_operation", "headless browsers don't support replays at this time");
    }
    const recordAudio = body.record_audio === true;
    const { replayId, replay } = await this.beginReplay(record, fps, maxSeconds, recordAudio);
    sendJson(res, 200, this.replayResponse(req, replayId, replay));
  }

  private async captureReplayFrame(replay: BrowserReplay): Promise<void> {
    if (replay.finishedAt || replay.capture) return replay.capture;
    const framePath = `${replay.directory}/frame-${String(replay.frame++).padStart(8, "0")}.png`;
    const capture = (async () => {
      const record = await this.loadRecord(replay.vm.id);
      const payload = await this.executePlaywright(record, `await page.screenshot({path:${JSON.stringify(framePath)}}); return true;`);
      if (!payload.success) throw new KernelHttpError(502, "replay_capture_failed", String(payload.error || "replay screenshot failed"));
    })();
    replay.capture = capture;
    try { await capture; } finally { replay.capture = undefined; }
  }

  private async startReplayAudio(replay: BrowserReplay): Promise<void> {
    if (!replay.audioPath || !replay.audioPidPath) return;
    const inner = [
      `echo $$ > ${shellQuote(replay.audioPidPath)}`,
      `exec env PULSE_SERVER=unix:/run/arker-pulse/native ffmpeg -nostdin -hide_banner -loglevel error -y -f pulse -i arker_output.monitor -ar 48000 -ac 2 -c:a pcm_s16le ${shellQuote(replay.audioPath)}`,
    ].join("; ");
    await this.runChecked(replay.vm, `setsid -f /bin/bash -lc ${shellQuote(inner)}`, 20);
    await this.runChecked(
      replay.vm,
      `for _ in $(seq 1 100); do test -s ${shellQuote(replay.audioPidPath)} && kill -0 "$(cat ${shellQuote(replay.audioPidPath)})" 2>/dev/null && PULSE_SERVER=unix:/run/arker-pulse/native pactl list short source-outputs 2>/dev/null | grep -q . && exit 0; sleep 0.1; done; exit 1`,
      15,
    );
  }

  private async stopReplayAudio(replay: BrowserReplay): Promise<void> {
    if (!replay.audioPath || !replay.audioPidPath) return;
    const pidPath = shellQuote(replay.audioPidPath);
    const audioPath = shellQuote(replay.audioPath);
    await this.runChecked(
      replay.vm,
      [
        `if test -s ${pidPath}; then pid=$(cat ${pidPath}); else pid=; fi`,
        `if test -n "$pid" && test -r "/proc/$pid/cmdline" && ! tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -F -- ${audioPath} >/dev/null; then pid=; fi`,
        `if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then kill -INT "$pid" 2>/dev/null || true; for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; fi`,
        `if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; fi`,
        `if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi`,
        `rm -f -- ${pidPath}`,
      ].join("; "),
      20,
    );
    replay.audioPidPath = undefined;
  }

  private async finishReplay(replayId: string, replay: BrowserReplay): Promise<void> {
    if (replay.finishedAt) return;
    if (!replay.finishing) {
      replay.finishing = (async () => {
        if (replay.timer) clearInterval(replay.timer);
        if (replay.maxTimer) clearTimeout(replay.maxTimer);
        replay.timer = undefined;
        replay.maxTimer = undefined;
        if (replay.capture) await replay.capture;
        if (replay.recordAudio) {
          await this.stopReplayAudio(replay);
          await this.runChecked(replay.vm, `test -s ${shellQuote(replay.audioPath!)}`, 20);
        }
        // Prevent ffmpeg from reading the service session's stdin, and bound
        // both frame count and wall time for malformed image sequences.
        const frameCount = Math.max(1, replay.frame);
        const audioInput = replay.recordAudio ? ` -i ${shellQuote(replay.audioPath!)}` : "";
        const audioOutput = replay.recordAudio ? " -map 0:v:0 -map 1:a:0 -c:a aac -b:a 128k -shortest" : "";
        await this.runChecked(
          replay.vm,
          `timeout -k 5s 60s ffmpeg -nostdin -hide_banner -loglevel error -y -framerate ${replay.fps} -start_number 0 -i ${shellQuote(`${replay.directory}/frame-%08d.png`)}${audioInput} -frames:v ${frameCount} -vf 'scale=trunc(iw/2)*2:trunc(ih/2)*2' -c:v libx264 -pix_fmt yuv420p${audioOutput} ${shellQuote(replay.outputPath)}`,
          75,
        );
        replay.finishedAt = isoNow();
        this.browserReplays.set(replayId, replay);
      })();
    }
    try {
      await replay.finishing;
    } finally {
      replay.finishing = undefined;
    }
  }

  private async stopReplay(res: ServerResponse, id: string, replayId: string): Promise<void> {
    const record = await this.loadRecord(id);
    const replay = this.browserReplays.get(replayId);
    if (!replay || replay.vm.id !== record.vm.id) throw new KernelHttpError(404, "not_found", `Replay ${replayId} not found`);
    await this.finishReplay(replayId, replay);
    sendEmpty(res, 204);
  }

  private async downloadReplay(res: ServerResponse, id: string, replayId: string): Promise<void> {
    const record = await this.loadRecord(id);
    const replay = this.browserReplays.get(replayId);
    if (!replay || replay.vm.id !== record.vm.id) throw new KernelHttpError(404, "not_found", `Replay ${replayId} not found`);
    await this.withVmPinned(replay.vm, async () => {
      await this.finishReplay(replayId, replay);
      sendBinary(res, 200, await replay.vm.sync(replay.outputPath), "video/mp4");
    });
  }

  private async directBrowser(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const match = url.pathname.match(/^\/browser\/direct\/([^/]+)\/(curl(?:\/raw)?|telemetry\/stream)$/);
    if (!match) throw new KernelHttpError(404, "not_found", "Direct browser route not found");
    const id = decodeURIComponent(match[1]!);
    if (!this.validToken("direct", id, url.searchParams.get("jwt") || url.searchParams.get("token"))) {
      throw new KernelHttpError(401, "invalid_token", "Invalid direct-browser token");
    }
    if (match[2] === "telemetry/stream") {
      return this.telemetryStream(req, res, url, id);
    }
    if (match[2] === "curl") {
      if (req.method !== "POST") throw new KernelHttpError(405, "method_not_allowed", "curl requires POST");
      await this.browserCurl(req, res, id);
      return;
    }
    if (!url.searchParams.get("url")) throw new KernelHttpError(422, "validation_error", "url is required");
    const record = await this.loadRecord(id);
    const requestBody = ["GET", "HEAD"].includes(req.method || "GET") ? undefined : await readBody(req);
    const headers: Record<string, string> = {};
    const hopByHopHeaders = new Set([
      "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
      "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    ]);
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null || hopByHopHeaders.has(key)) continue;
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    const response = await this.browserHttp(record, {
      url: url.searchParams.get("url"),
      method: req.method || "GET",
      headers,
      body_b64: requestBody?.toString("base64"),
      timeout_ms: Number(url.searchParams.get("timeout_ms") || 30_000),
    });
    for (const [key, values] of Object.entries(response.headers)) {
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) continue;
      res.setHeader(key, values);
    }
    res.writeHead(response.status, { "content-length": response.body.length });
    res.end(response.body);
  }

  private async runChecked(vm: VM, command: string, timeout?: number, memoryMib?: number): Promise<CompletedRunResult> {
    const session = await vm.createSession();
    try {
      const result = await vm.run(command, { timeout, memory_mib: memoryMib, session_id: session.session_id });
      if (result.type !== "completed") throw new KernelHttpError(502, "execution_failed", "Arker run did not complete");
      if (result.exitCode !== 0) {
        const stderr = runText(result, "stderr").trim();
        const stdout = runText(result, "stdout").trim();
        throw new KernelHttpError(502, "execution_failed", stderr || stdout || `guest command exited ${result.exitCode}`);
      }
      return result;
    } finally {
      await vm.deleteSession(session.session_id).catch(() => undefined);
    }
  }

  private async runServiceChecked(vm: VM, command: string, timeout?: number, memoryMib?: number): Promise<CompletedRunResult> {
    return this.withVmPinned(vm, async () => {
      const result = await vm.run(command, {
        timeout,
        memory_mib: memoryMib,
        session_idx: SERVICE_SESSION_INDEX,
        // The reference-counted outer pin keeps detached browser children
        // progressing through startup and any enclosing host/guest sync.
        keep_alive: true,
      });
      if (result.type !== "completed") throw new KernelHttpError(502, "execution_failed", "Arker service run did not complete");
      if (result.exitCode !== 0) {
        const stderr = runText(result, "stderr").trim();
        const stdout = runText(result, "stdout").trim();
        throw new KernelHttpError(502, "execution_failed", stderr || stdout || `guest service command exited ${result.exitCode}`);
      }
      return result;
    });
  }

  private async withVmPinned<T>(vm: VM, operation: () => Promise<T>): Promise<T> {
    await this.acquireVmPin(vm);
    try {
      return await operation();
    } finally {
      await this.releaseVmPin(vm);
    }
  }

  private async acquireVmPin(vm: VM): Promise<void> {
    await this.withVmPinState(vm.id, async () => {
      const count = this.vmPinCounts.get(vm.id) ?? 0;
      if (count === 0) {
        const scheduled = this.vmStandbyTimers.get(vm.id);
        if (scheduled) {
          clearTimeout(scheduled.timer);
          this.vmStandbyTimers.delete(vm.id);
          this.knownAwakeVms.add(vm.id);
          this.vmPinCounts.set(vm.id, 1);
          return;
        }
        // A known-awake VM was either adopted directly from a warm-memory fork
        // or deliberately left allocated by its last release. Repeating the
        // run+sync readiness handshake would add a full Arker round trip.
        if (this.knownAwakeVms.has(vm.id)) {
          this.vmPinCounts.set(vm.id, 1);
          return;
        }
        let wakeResult: CompletedRunResult | undefined;
        let wakeError: unknown;
        const wakeStarted = performance.now();
        const wakeAttempts = Math.max(5, this.options.createAttempts);
        for (let attempt = 1; attempt <= wakeAttempts; attempt += 1) {
          try {
            const result = await vm.run("true", {
              timeout: 20,
              session_idx: SERVICE_SESSION_INDEX,
              keep_alive: true,
              idempotencyKey: randomUUID(),
            });
            if (result.type !== "completed" || result.exitCode !== 0) {
              throw new KernelHttpError(502, "execution_failed", "Unable to wake and pin the Arker browser VM");
            }
            // Do not expose the pin until command and filesystem paths are ready.
            await vm.sync("/etc/os-release");
            wakeResult = result;
            break;
          } catch (error) {
            wakeError = error;
            if (attempt >= wakeAttempts || !isTransientArkerCreateFailure(error)) throw error;
            await new Promise((resolveWake) => setTimeout(resolveWake, attempt * 250));
          }
        }
        if (!wakeResult) throw wakeError;
        this.debugTiming("vm.resume", wakeStarted, { vm_id: vm.id });
        this.knownAwakeVms.add(vm.id);
      }
      this.vmPinCounts.set(vm.id, count + 1);
    });
  }

  private async releaseVmPin(vm: VM): Promise<void> {
    await this.withVmPinState(vm.id, async () => {
      const count = this.vmPinCounts.get(vm.id) ?? 0;
      if (count === 0) return;
      if (count > 1) {
        this.vmPinCounts.set(vm.id, count - 1);
        return;
      }
      this.vmPinCounts.delete(vm.id);
      if (!this.options.automaticStandby) return;
      if (this.closing || this.options.standbyDelayMs === 0) {
        await this.standbyVm(vm);
        return;
      }
      const timer = setTimeout(() => {
        void this.withVmPinState(vm.id, async () => {
          const scheduled = this.vmStandbyTimers.get(vm.id);
          if (!scheduled || scheduled.timer !== timer) return;
          this.vmStandbyTimers.delete(vm.id);
          if ((this.vmPinCounts.get(vm.id) ?? 0) === 0) await this.standbyVm(vm);
        }).catch(() => undefined);
      }, this.options.standbyDelayMs);
      timer.unref?.();
      this.vmStandbyTimers.set(vm.id, { timer, vm });
    });
  }

  private async standbyVm(vm: VM): Promise<void> {
    // Flush guest files before releasing idle compute. The idempotency key
    // makes a transient response retry safe.
    this.knownAwakeVms.delete(vm.id);
    const standbyStarted = performance.now();
    await vm.run("sync", {
      timeout: 120,
      session_idx: SERVICE_SESSION_INDEX,
      keep_alive: false,
      release: "cpu,memory",
      idempotencyKey: randomUUID(),
    }).catch(() => undefined);
    this.debugTiming("vm.standby", standbyStarted, { vm_id: vm.id });
  }

  private async flushScheduledStandby(): Promise<void> {
    const scheduled = [...this.vmStandbyTimers.entries()];
    this.vmStandbyTimers.clear();
    for (const [, item] of scheduled) clearTimeout(item.timer);
    await Promise.all(scheduled.map(([vmId, item]) => this.withVmPinState(vmId, async () => {
      if ((this.vmPinCounts.get(vmId) ?? 0) === 0) await this.standbyVm(item.vm);
    }).catch(() => undefined)));
  }

  private async withVmPinState<T>(vmId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.vmPinStateQueues.get(vmId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const marker = result.then(() => undefined, () => undefined);
    this.vmPinStateQueues.set(vmId, marker);
    try {
      return await result;
    } finally {
      if (this.vmPinStateQueues.get(vmId) === marker) this.vmPinStateQueues.delete(vmId);
    }
  }

  private async withVmControl<T>(vmId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.vmControlQueues.get(vmId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const marker = result.then(() => undefined, () => undefined);
    this.vmControlQueues.set(vmId, marker);
    try {
      return await result;
    } finally {
      if (this.vmControlQueues.get(vmId) === marker) this.vmControlQueues.delete(vmId);
    }
  }

  private async releaseDetachedSession(process: DetachedProcess): Promise<void> {
    const sessionId = process.sessionId;
    if (sessionId) {
      process.sessionId = undefined;
      await process.vm.deleteSession(sessionId).catch(() => undefined);
    }
    if (process.pinHeld) {
      process.pinHeld = false;
      await this.releaseVmPin(process.vm);
    }
  }

  private async releaseInteractivePin(process: InteractiveProcess): Promise<void> {
    if (!process.pinHeld) return;
    process.pinHeld = false;
    await this.releaseVmPin(process.vm);
  }

  private async proxyLiveView(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const match = url.pathname.match(/^\/browser\/live\/([^/]+)\/(.*)$/);
    if (!match) throw new KernelHttpError(404, "not_found", "live view route not found");
    const id = decodeURIComponent(match[1]!);
    const token = url.searchParams.get("token") || parseCookies(req)[`arker_kernel_live_${id}`];
    if (!this.validToken("live", id, token)) throw new KernelHttpError(401, "invalid_token", "Invalid live-view token");
    const record = await this.loadRecord(id);
    if (url.searchParams.has("token")) {
      const secure = new URL(this.publicBaseUrl(req)).protocol === "https:" ? "; Secure" : "";
      res.setHeader("set-cookie", `arker_kernel_live_${id}=${this.token("live", id)}; HttpOnly; SameSite=Lax${secure}; Path=/browser/live/${encodeURIComponent(id)}/`);
    }
    const target = new URL(`https://${insertPort(record.metadata.hostname, 6080)}/${match[2]}${url.search}`);
    target.searchParams.delete("token");
    const response = await fetch(target, {
      headers: this.forwardApiKey ? { authorization: `Bearer ${this.forwardApiKey}` } : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!["connection", "content-encoding", "content-length", "set-cookie", "transfer-encoding"].includes(key)) headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  private async handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): Promise<void> {
    let pinnedVm: VM | undefined;
    let pinTransferred = false;
    try {
      const url = new URL(req.url || "/", this.publicBaseUrl(req));
      let target: string;
      let browserId: string;
      let browserRecord: BrowserRecord;
      let liveView = false;
      if (url.pathname === "/browser/cdp") {
        const id = url.searchParams.get("session_id") || "";
        if (!this.validToken("cdp", id, url.searchParams.get("token"))) throw new KernelHttpError(401, "invalid_token", "Invalid CDP token");
        const record = await this.loadRecord(id);
        this.touch(record);
        browserRecord = record;
        browserId = record.vm.id;
        target = `wss://${insertPort(record.metadata.hostname, 9222)}${record.metadata.cdpPath}`;
      } else if (url.pathname === "/browser/bidi") {
        const id = url.searchParams.get("session_id") || "";
        if (!this.validToken("bidi", id, url.searchParams.get("token"))) throw new KernelHttpError(401, "invalid_token", "Invalid WebDriver BiDi token");
        const record = await this.loadRecord(id);
        if (!record.metadata.bidiPath) throw new KernelHttpError(409, "bidi_not_ready", "WebDriver BiDi is unavailable for this legacy browser session");
        this.touch(record);
        browserRecord = record;
        browserId = record.vm.id;
        target = `wss://${insertPort(record.metadata.hostname, 9515)}${record.metadata.bidiPath}`;
      } else {
        const match = url.pathname.match(/^\/browser\/live\/([^/]+)\/(.*)$/);
        if (!match) throw new KernelHttpError(404, "not_found", "WebSocket route not found");
        const id = decodeURIComponent(match[1]!);
        const token = url.searchParams.get("token") || parseCookies(req)[`arker_kernel_live_${id}`];
        if (!this.validToken("live", id, token)) throw new KernelHttpError(401, "invalid_token", "Invalid live-view token");
        const record = await this.loadRecord(id);
        liveView = true;
        browserRecord = record;
        browserId = record.vm.id;
        const upstream = new URL(`https://${insertPort(record.metadata.hostname, 6080)}/${match[2]}${url.search}`);
        upstream.searchParams.delete("token");
        target = upstream.toString().replace(/^https:/, "wss:");
      }
      await this.acquireVmPin(browserRecord.vm);
      pinnedVm = browserRecord.vm;
      await new Promise<void>((resolveUpgrade, rejectUpgrade) => {
        try {
          this.webSockets.handleUpgrade(req, socket, head, (client) => {
        pinTransferred = true;
        let pinReleased = false;
        const releasePin = () => {
          if (pinReleased) return;
          pinReleased = true;
          void this.releaseVmPin(browserRecord.vm);
        };
        this.activeBrowserConnections.set(browserId, (this.activeBrowserConnections.get(browserId) || 0) + 1);
        if (liveView) this.activeLiveConnections.set(browserId, (this.activeLiveConnections.get(browserId) || 0) + 1);
        const upstreamOptions = {
          handshakeTimeout: 30_000,
          ...(this.forwardApiKey ? { headers: { authorization: `Bearer ${this.forwardApiKey}` } } : {}),
        };
        // noVNC/websockify negotiates the `binary` subprotocol. Preserve the
        // protocol selected on the downstream handshake when opening the
        // upstream connection; CDP normally leaves this empty.
        const upstream = client.protocol
          ? new WebSocket(target, client.protocol, upstreamOptions)
          : new WebSocket(target, upstreamOptions);
        this.upstreamWebSockets.add(upstream);
        const queued: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
        let queuedBytes = 0;
        client.on("message", (data, binary) => {
          const size = rawWebSocketBytes(data);
          if (upstream.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount + size > MAX_PENDING_WEBSOCKET_BYTES) {
              client.close(1009, "upstream WebSocket buffer exceeded 16 MiB");
              upstream.terminate();
              return;
            }
            upstream.send(data, { binary });
          }
          else if (upstream.readyState === WebSocket.CONNECTING) {
            if (queuedBytes + size > MAX_PENDING_WEBSOCKET_BYTES) {
              queued.length = 0;
              queuedBytes = 0;
              client.close(1009, "upstream connection queue exceeded 16 MiB");
              upstream.terminate();
              return;
            }
            queued.push({ data, binary });
            queuedBytes += size;
          }
        });
        upstream.on("open", () => {
          for (const item of queued) upstream.send(item.data, { binary: item.binary });
          queued.length = 0;
          queuedBytes = 0;
        });
        upstream.on("message", (data, binary) => {
          if (client.readyState !== WebSocket.OPEN) return;
          const size = rawWebSocketBytes(data);
          if (client.bufferedAmount + size > MAX_PENDING_WEBSOCKET_BYTES) {
            client.close(1009, "downstream WebSocket buffer exceeded 16 MiB");
            upstream.terminate();
            return;
          }
          client.send(data, { binary });
        });
        client.on("close", (code, reason) => {
          this.touch(browserRecord);
          const remaining = Math.max(0, (this.activeBrowserConnections.get(browserId) || 1) - 1);
          if (remaining) this.activeBrowserConnections.set(browserId, remaining);
          else this.activeBrowserConnections.delete(browserId);
          if (liveView) {
            const remainingLive = Math.max(0, (this.activeLiveConnections.get(browserId) || 1) - 1);
            if (remainingLive) this.activeLiveConnections.set(browserId, remainingLive);
            else this.activeLiveConnections.delete(browserId);
          }
          relayWebSocketClose(upstream, code, reason);
          releasePin();
        });
        upstream.on("close", (code, reason) => {
          this.upstreamWebSockets.delete(upstream);
          relayWebSocketClose(client, code, reason);
          releasePin();
        });
        upstream.on("error", () => client.close(1011, "upstream WebSocket failed"));
        client.on("error", () => upstream.close());
            resolveUpgrade();
          });
        } catch (error) {
          rejectUpgrade(error);
        }
      });
    } catch {
      if (pinnedVm && !pinTransferred) await this.releaseVmPin(pinnedVm).catch(() => undefined);
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  }

  private async sweepExpired(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
    const now = Date.now();
    const reconciliationDue = [...this.creationReconciliations.values()].some((item) => {
      const delay = CREATION_RECONCILE_DELAYS_MS[item.scanIndex];
      return delay !== undefined && now - item.createdAtMs >= delay;
    });
    let listedVms: VM[] | undefined;
    if (now - this.lastSweepDiscoveryAt >= 60_000 || reconciliationDue) {
      listedVms = await this.listAllVms().catch(() => undefined);
    }
    if (listedVms && reconciliationDue) {
      for (const [token, item] of this.creationReconciliations) {
        const delay = CREATION_RECONCILE_DELAYS_MS[item.scanIndex];
        if (delay === undefined) {
          this.creationReconciliations.delete(token);
          continue;
        }
        if (now - item.createdAtMs < delay || item.pendingRequests > 0) continue;
        const duplicates = listedVms.filter((vm) =>
          (vm as unknown as { description?: unknown }).description === token
          && vm.id !== item.keepVmId
          && !item.activeVmIds.has(vm.id));
        await Promise.all(duplicates.map((vm) => vm.delete().catch(() => undefined)));
        item.scanIndex += 1;
        if (item.scanIndex >= CREATION_RECONCILE_DELAYS_MS.length) this.creationReconciliations.delete(token);
      }
    }
    if (listedVms && now - this.lastSweepDiscoveryAt >= 60_000) {
      this.lastSweepDiscoveryAt = now;
      for (const vm of listedVms) {
        const description = (vm as unknown as { description?: unknown }).description;
        if (typeof description !== "string" || !description.startsWith(METADATA_PREFIX) || this.cache.has(vm.id)) continue;
        const metadata = await this.metadataForVm(vm);
        if (!metadata) continue;
        const record = { vm, metadata };
        // A proxy restart severs the old CDP/live connections, so begin a new
        // inactivity window instead of deleting from a stale persisted clock.
        this.touch(record);
        this.cacheRecord(record);
        if (metadata.creationToken && description === metadata.creationToken && !this.creationReconciliations.has(metadata.creationToken)) {
          this.creationReconciliations.set(metadata.creationToken, {
            createdAtMs: now,
            scanIndex: 0,
            pendingRequests: 0,
            activeVmIds: new Set(),
            keepVmId: vm.id,
          });
        }
      }
    }
    const unique = new Set([...this.cache.values()]);
    for (const record of unique) {
      if (this.activeBrowserConnections.has(record.vm.id)) continue;
      if (record.metadata.pool?.state === "idle") continue;
      if (now - Date.parse(record.metadata.lastActivityAt) < record.metadata.timeoutSeconds * 1_000) continue;
      await this.cleanupBrowserResources(record.vm.id).catch(() => undefined);
      try { await this.saveProfileChanges(record); } catch { continue; }
      await record.vm.delete().catch(() => {});
      this.forgetRecord(record);
    }
    } finally {
      this.sweeping = false;
    }
  }
}

export async function startKernelProxy(options: KernelProxyOptions = {}): Promise<KernelProxy> {
  const proxy = new KernelProxy(options);
  await proxy.listen();
  return proxy;
}

export type KernelLambdaProxyOptions = Omit<
  KernelProxyOptions,
  "host" | "port" | "publicBaseUrl" | "apiKey" | "stateDirectory"
> & {
  /** Local bearer key returned to the Kernel SDK. A random cold-start key is used by default. */
  apiKey?: string;
  /** Lambda-writable registry path. Defaults to /tmp/arker-kernel-proxy. */
  stateDirectory?: string;
};

export interface KernelLambdaProxyHandle {
  proxy: KernelProxy;
  /** Pass this value to the official Kernel client's `baseURL` option. */
  baseURL: string;
  /** Pass this value to the official Kernel client's `apiKey` option. */
  apiKey: string;
}

let lambdaKernelProxyPromise: Promise<KernelLambdaProxyHandle> | undefined;

/**
 * Start one loopback proxy per warm Lambda execution environment and reuse it
 * across invocations. The listener is unref'd so it cannot keep an invocation
 * open after the handler's promise resolves.
 */
export function getOrStartKernelProxyForLambda(
  options: KernelLambdaProxyOptions = {},
): Promise<KernelLambdaProxyHandle> {
  if (lambdaKernelProxyPromise) return lambdaKernelProxyPromise;
  const apiKey = options.apiKey?.trim() || env("KERNEL_PROXY_API_KEY") || randomBytes(32).toString("base64url");
  lambdaKernelProxyPromise = (async () => {
    const proxy = await startKernelProxy({
      ...options,
      apiKey,
      host: "127.0.0.1",
      port: 0,
      stateDirectory: options.stateDirectory ?? "/tmp/arker-kernel-proxy",
    });
    proxy.server.unref();
    const address = proxy.server.address() as AddressInfo;
    return { proxy, baseURL: `http://127.0.0.1:${address.port}`, apiKey };
  })();
  void lambdaKernelProxyPromise.catch(() => {
    lambdaKernelProxyPromise = undefined;
  });
  return lambdaKernelProxyPromise;
}

export async function prepareKernelProxySource(options: KernelProxyOptions = {}, name?: string): Promise<VM> {
  return new KernelProxy(options).prepareSource(name);
}
