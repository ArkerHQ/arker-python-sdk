/**
 * Live SDK demo.
 *
 * Run:
 *   ARKER_API_KEY=ark_live_... \
 *   ARKER_REGION=aws-us-west-2 \
 *   ARKER_SOURCE_VM=ubuntu \
 *   npm run demo
 */

import { Arker, ArkerError, Computer, type CompletedRunResult } from "../src/index.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() || undefined;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function assertCompleted(result: unknown): asserts result is CompletedRunResult {
  if (!result || typeof result !== "object" || (result as { type?: unknown }).type !== "completed") {
    throw new Error(`expected completed run result, got ${JSON.stringify(result)}`);
  }
}

const apiKey = requiredEnv("ARKER_API_KEY");
const baseUrl = optionalEnv("ARKER_BASE_URL");
const region = optionalEnv("ARKER_REGION");
const sourceVm = requiredEnv("ARKER_SOURCE_VM");

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" && init.body.length <= 220 ? ` body=${init.body}` : "";
  console.log(`${method} ${url}${body}`);
  return originalFetch(input, init);
}) as typeof fetch;

const arker = new Arker({ apiKey, baseUrl, region });
const source = arker.vm(sourceVm);
if (!(source instanceof Computer)) throw new Error("vm() did not return a Computer");

let vm: Computer | undefined;

try {
  vm = await source.fork({ name: "ts-sdk-demo" });

  const hello = "hello-from-ts-sdk";
  const run = await vm.run(`printf '${hello}\\n'`);
  assertCompleted(run);
  if (run.exitCode !== 0 || decode(run.stdout) !== `${hello}\n`) {
    throw new Error(`unexpected run output: exit=${run.exitCode} stdout=${JSON.stringify(decode(run.stdout))}`);
  }

  await vm.sync.writeFile("/home/user/ts-sdk-demo.txt", `${hello}\n`);
  const file = await vm.sync.readFile("/home/user/ts-sdk-demo.txt");
  if (decode(file) !== `${hello}\n`) throw new Error("sync round trip failed");

  console.log(`PASS ${vm.id}`);
} catch (error) {
  if (error instanceof ArkerError) {
    console.error(`FAIL ${error.code} status=${error.status}: ${error.message}`);
  } else {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
} finally {
  if (vm) await vm.delete().catch(() => undefined);
}
