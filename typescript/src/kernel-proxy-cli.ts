#!/usr/bin/env node

import { prepareKernelProxySource, startKernelProxy, type KernelProxyOptions } from "./kernel-proxy.js";

function usage(exitCode = 2): never {
  console.error(`Usage: arker-kernel-proxy [options]

Run a Kernel REST-compatible browser API backed by Arker VMs.

Options:
  --host <address>       Bind address (default: 127.0.0.1)
  --port <number>        Bind port (default: 8787)
  --public-url <url>     Public origin used in returned CDP/direct/live-view URLs
  --arker-url <url>      Regional Arker API endpoint
  --source <vm-name>     Arker source VM (default: ubuntu-full)
  --source-id <vm-id>    Exact prepared source VM ID
  --source-layers <list> Source state: disk or disk,memory
  --platforms <list>     Comma-separated Arker platforms (default: icelake)
  --setup-script <path>  Edited CloakBrowser guest setup script
  --setup-memory <MiB>   Memory used while installing the browser (default: 4096)
  --runtime-memory <MiB> Steady-state browser VM memory target
  --runtime-vcpu <n>     Steady-state browser VM vCPU target
  --create-attempts <n>  Transient create attempts (default: 3, max: 5)
  --automatic-standby    Enable Arker idle suspension (default)
  --keep-running         Disable automatic standby for latency-sensitive sessions
  --standby-delay <ms>   Coalescing idle window before standby (default: 5000)
  --state-dir <path>     Durable profiles/extensions/proxies/pools registry
  --prepare-source <name>  Build a durable prepared source, print its VM ID, and exit
  --help                 Show this help

Environment:
  ARKER_API_KEY                 Arker credential (required)
  KERNEL_PROXY_API_KEY          Optional REST bearer guard; required off-loopback
  KERNEL_PROXY_SIGNING_SECRET   Stable CDP/direct/live-view signing secret
  KERNEL_PROXY_ARKER_PLATFORMS  Comma-separated platform preference
  KERNEL_PROXY_CREATE_ATTEMPTS  Transient create attempts (default: 3)
  KERNEL_PROXY_AUTOMATIC_STANDBY  Idle suspension toggle (default: true)
  KERNEL_PROXY_STANDBY_DELAY_MS   Coalescing idle window (default: 5000)
  KERNEL_PROXY_STATE_DIR        Durable control-resource registry directory
  KERNEL_PROXY_SETUP_MEMORY_MIB Memory used while installing the browser
  KERNEL_PROXY_RUNTIME_MEMORY_MIB  Steady-state browser VM memory target
  KERNEL_PROXY_RUNTIME_VCPU     Steady-state browser VM vCPU target
  KERNEL_PROXY_DEBUG_TIMING     Emit structured latency stages on stderr
  CLOAKBROWSER_LICENSE_KEY      Optional current CloakBrowser binary license
  CLOAKBROWSER_VERSION          Binary pin (default: 146.0.7680.177.5)
  CLOAKBROWSER_NPM_VERSION      Wrapper pin (default: 0.5.5)
`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
const options: KernelProxyOptions = {};
let prepareSourceName: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  const value = () => args[++index] ?? usage();
  if (arg === "--help" || arg === "-h") usage(0);
  else if (arg === "--host") options.host = value();
  else if (arg === "--port") options.port = Number(value());
  else if (arg === "--public-url") options.publicBaseUrl = value();
  else if (arg === "--arker-url") options.arkerBaseUrl = value();
  else if (arg === "--source") options.sourceVmName = value();
  else if (arg === "--source-id") options.sourceVmId = value();
  else if (arg === "--source-layers") options.sourceLayers = value().split(",").map((item) => item.trim()) as Array<"disk" | "memory">;
  else if (arg === "--platforms") options.sourcePlatforms = value().split(",").map((item) => item.trim()).filter(Boolean);
  else if (arg === "--setup-script") options.setupScriptPath = value();
  else if (arg === "--setup-memory") options.setupMemoryMib = Number(value());
  else if (arg === "--runtime-memory") options.runtimeMemoryMib = Number(value());
  else if (arg === "--runtime-vcpu") options.runtimeVcpu = Number(value());
  else if (arg === "--create-attempts") options.createAttempts = Number(value());
  else if (arg === "--automatic-standby") options.automaticStandby = true;
  else if (arg === "--keep-running") options.automaticStandby = false;
  else if (arg === "--standby-delay") options.standbyDelayMs = Number(value());
  else if (arg === "--state-dir") options.stateDirectory = value();
  else if (arg === "--prepare-source") prepareSourceName = value();
  else usage();
}

async function main(): Promise<void> {
  if (prepareSourceName) {
    const source = await prepareKernelProxySource(options, prepareSourceName);
    console.log(JSON.stringify({ source_vm_id: source.id, name: source.name }));
    return;
  }
  const proxy = await startKernelProxy(options);
  const address = proxy.server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  console.log(`Arker Kernel proxy listening on ${options.publicBaseUrl ?? `http://${options.host ?? "127.0.0.1"}:${port}`}`);
  console.log("Set KERNEL_BASE_URL to that URL in any official Kernel SDK.");

  const shutdown = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
