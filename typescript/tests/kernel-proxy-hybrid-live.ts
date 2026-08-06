/**
 * Live Kernel-upstream smoke test for the session-affine hybrid router.
 *
 * Required: KERNEL_API_KEY and ARKER_API_KEY. The Arker client is configured
 * but is not called because this test sends 100% of creates to Kernel.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Kernel from "@onkernel/sdk";

import { Arker } from "../src/index.js";
import { startKernelProxy } from "../src/kernel-proxy.js";

const kernelApiKey = process.env.KERNEL_API_KEY;
const arkerApiKey = process.env.ARKER_API_KEY;
const arkerBaseUrl = process.env.ARKER_BASE_URL ?? process.env.ARKER_URL;
if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
if (!arkerApiKey) throw new Error("ARKER_API_KEY is required");
if (!arkerBaseUrl) throw new Error("ARKER_BASE_URL or ARKER_URL is required");

const stateDirectory = await mkdtemp(join(tmpdir(), "arker-kernel-hybrid-live-"));
const arker = new Arker({ apiKey: arkerApiKey, baseUrl: arkerBaseUrl, controlBaseUrl: arkerBaseUrl });
const localApiKey = "kernel-hybrid-live-local-key";
let proxy = await startKernelProxy({
  arker,
  apiKey: localApiKey,
  signingSecret: "kernel-hybrid-live-signing-secret",
  host: "127.0.0.1",
  port: 0,
  stateDirectory,
  hybridRouting: {
    kernelApiKey,
    kernelTrafficPercent: 100,
    fallbackToArkerOnCreateError: false,
    fallbackToArkerOnNotFound: true,
  },
});
let browserId: string | undefined;

try {
  let address = proxy.server.address();
  assert(address && typeof address === "object");
  let kernel = new Kernel({
    apiKey: localApiKey,
    baseURL: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
  });
  const created = await kernel.browsers.create({
    name: `arker-hybrid-live-${Date.now()}`,
    headless: true,
    timeout_seconds: 120,
  });
  browserId = created.session_id;
  assert(browserId);
  assert.equal((await kernel.browsers.retrieve(browserId)).session_id, browserId);

  await proxy.close();
  proxy = await startKernelProxy({
    arker,
    apiKey: localApiKey,
    signingSecret: "kernel-hybrid-live-signing-secret",
    host: "127.0.0.1",
    port: 0,
    stateDirectory,
    hybridRouting: {
      kernelApiKey,
      kernelTrafficPercent: 0,
      fallbackToArkerOnCreateError: false,
      fallbackToArkerOnNotFound: false,
    },
  });
  address = proxy.server.address();
  assert(address && typeof address === "object");
  kernel = new Kernel({
    apiKey: localApiKey,
    baseURL: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
  });
  assert.equal((await kernel.browsers.retrieve(browserId)).session_id, browserId);
  await kernel.browsers.deleteByID(browserId);
  browserId = undefined;
  console.log("PASS Kernel hybrid production create/restart/retrieve/delete");
} finally {
  if (browserId) {
    const address = proxy.server.address();
    if (address && typeof address === "object") {
      const cleanup = new Kernel({ apiKey: localApiKey, baseURL: `http://127.0.0.1:${address.port}`, maxRetries: 0 });
      await cleanup.browsers.deleteByID(browserId).catch(() => undefined);
    }
  }
  if (proxy.server.listening) await proxy.close();
  await rm(stateDirectory, { recursive: true, force: true });
}
