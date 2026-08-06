# Kernel browser API compatibility proxy

`arker-kernel-proxy` serves the Kernel browser REST contract while each browser
runs in an isolated Arker VM. Official Kernel TypeScript and Python clients can
use it by setting their existing REST base URL; no language-specific adapter is
required.

The compatibility boundary is Kernel's browser platform: lifecycle, CDP,
WebDriver BiDi, process and PTY operations, filesystem and watch operations,
Playwright execution, computer control, telemetry, replays, profiles,
extensions, custom proxies, and browser pools. Kernel's application and
organization control planes are outside this boundary and return structured
unsupported responses.

## Prepare a browser source

The fallback path installs the browser stack while creating a session. For fast
creates, install it once in a prepared source and use warm disk-and-memory forks:

```bash
export ARKER_API_KEY=...

arker-kernel-proxy \
  --source ubuntu-full \
  --prepare-source my-kernel-browser-source
```

The command prints a `source_vm_id`. Keep that source running, store its ID in
deployment configuration, and rebuild it whenever the setup script or browser
pins change.

For memory-constrained workloads, the tested 512 MiB configuration is:

```bash
arker-kernel-proxy \
  --source ubuntu-small \
  --setup-memory 2048 \
  --runtime-memory 512 \
  --runtime-vcpu 1 \
  --prepare-source my-kernel-browser-source-512
```

The setup script uses a temporary installation allowance, then configures disk
swap and bounded browser/runtime caches before validating the final 512 MiB
shape. Use the same runtime memory and vCPU values when starting the proxy so
the requested session matches the prepared source.

## Start the proxy

```bash
export ARKER_API_KEY=...
export KERNEL_PROXY_API_KEY='choose-a-long-random-proxy-key'
export KERNEL_PROXY_SIGNING_SECRET='choose-a-stable-random-signing-secret'

arker-kernel-proxy \
  --host 127.0.0.1 \
  --port 8787 \
  --public-url https://kernel-proxy.example.com \
  --source-id vmh-... \
  --source-layers disk,memory \
  --runtime-memory 512 \
  --runtime-vcpu 1 \
  --state-dir /var/lib/arker-kernel-proxy
```

Automatic standby is enabled after a five-second coalescing window. Nearby
operations cancel the pending standby transition. Use `--keep-running` when
lowest hot-request latency matters more than releasing idle compute, or change
the delay with `--standby-delay`.

`KERNEL_PROXY_API_KEY` is optional only on loopback and required on any other
bind address. Use TLS and normal network access controls when exposing the
proxy. A stable signing secret lets capability URLs survive proxy restarts.

The equivalent embedded configuration is:

```ts
import { startKernelProxy } from "@arker-ai/sdk/kernel-proxy";

const proxy = await startKernelProxy({
  arkerApiKey: process.env.ARKER_API_KEY,
  apiKey: process.env.KERNEL_PROXY_API_KEY,
  signingSecret: process.env.KERNEL_PROXY_SIGNING_SECRET,
  sourceVmId: process.env.ARKER_KERNEL_SOURCE_ID,
  sourceLayers: ["disk", "memory"],
  runtimeMemoryMib: 512,
  runtimeVcpu: 1,
  stateDirectory: "/var/lib/arker-kernel-proxy",
  host: "127.0.0.1",
  port: 8787,
});
```

## Split new browsers between Kernel and Arker

Hybrid routing is session-affine. The percentage is evaluated once for each
`POST /browsers`; every browser-scoped REST call after that stays with the
provider that created the session. An Arker-selected create always invokes a
new Arker VM fork.

```bash
export KERNEL_UPSTREAM_API_KEY='your-existing-kernel-key'

arker-kernel-proxy \
  --kernel-percent 20 \
  --fallback-to-arker-on-create-error \
  --fallback-to-arker-on-not-found \
  --source-id vmh-... \
  --source-layers disk,memory
```

Here, 20% of new browsers are created by Kernel and 80% are fresh Arker forks.
The upstream credential is separate from `KERNEL_PROXY_API_KEY` and is never
returned to clients. Provider assignments are stored in `registry.json`, so
existing sessions keep their route after a proxy restart even if the traffic
percentage changes.

The equivalent embedded options are:

```ts
const proxy = await startKernelProxy({
  arkerApiKey: process.env.ARKER_API_KEY,
  apiKey: process.env.KERNEL_PROXY_API_KEY,
  sourceVmId: process.env.ARKER_KERNEL_SOURCE_ID,
  sourceLayers: ["disk", "memory"],
  hybridRouting: {
    kernelApiKey: process.env.KERNEL_UPSTREAM_API_KEY,
    kernelTrafficPercent: 20,
    fallbackToArkerOnCreateError: true,
    fallbackToArkerOnNotFound: true,
    // Leave false unless duplicate creation is an acceptable failure mode.
    fallbackToArkerOnTransportError: false,
  },
});
```

Create fallback applies to explicit retryable Kernel responses: 404, 408, 425,
429, and 5xx. A validation or authentication error is returned unchanged.
Network failure fallback is disabled by default because Kernel may have created
the browser even if its response was lost; blindly retrying in Arker could then
create two sessions.

For an unrecorded browser reference, optional not-found fallback asks Kernel
first and tries Arker only after an explicit 404. This recovers routing for an
existing Arker browser; it cannot recreate lost Kernel browser state or retain
a missing Kernel session ID.

## Point official Kernel SDKs at it

Use the proxy key, not the Arker credential, as the Kernel SDK key:

```bash
export KERNEL_API_KEY="$KERNEL_PROXY_API_KEY"
export KERNEL_BASE_URL=http://127.0.0.1:8787
```

TypeScript:

```ts
import Kernel from "@onkernel/sdk";

const kernel = new Kernel({
  apiKey: process.env.KERNEL_API_KEY,
  baseURL: process.env.KERNEL_BASE_URL,
});

const browser = await kernel.browsers.create({
  headless: true,
  stealth: true,
  timeout_seconds: 900,
});

const result = await kernel.browsers.playwright.execute(browser.session_id, {
  code: "await page.goto('https://example.com'); return await page.title();",
});
```

Python sync and async clients use the same base URL:

```python
import os
from kernel import Kernel

kernel = Kernel(
    api_key=os.environ["KERNEL_API_KEY"],
    base_url=os.environ["KERNEL_BASE_URL"],
)
browser = kernel.browsers.create(headless=True, stealth=True, timeout_seconds=900)
```

## Use it from AWS Lambda

The simplest production topology is a separately hosted proxy reachable from
the Lambda function. The function uses the normal Kernel SDK and only changes
its base URL and API key:

```ts
import Kernel from "@onkernel/sdk";

const kernel = new Kernel({
  apiKey: process.env.KERNEL_PROXY_API_KEY,
  baseURL: process.env.KERNEL_PROXY_URL,
});

export const handler = async () => {
  const browser = await kernel.browsers.create({ headless: true });
  return { sessionId: browser.session_id };
};
```

For self-contained functions, start one loopback proxy during a cold start and
reuse it across warm invocations:

```ts
import Kernel from "@onkernel/sdk";
import { getOrStartKernelProxyForLambda } from "@arker-ai/sdk/kernel-proxy";

const proxyReady = getOrStartKernelProxyForLambda({
  arkerApiKey: process.env.ARKER_API_KEY,
  sourceVmId: process.env.ARKER_KERNEL_SOURCE_ID,
  sourceLayers: ["disk", "memory"],
  runtimeMemoryMib: 512,
  runtimeVcpu: 1,
});

const kernelReady = proxyReady.then(({ baseURL, apiKey }) =>
  new Kernel({ apiKey, baseURL }),
);

export const handler = async () => {
  const kernel = await kernelReady;
  const browser = await kernel.browsers.create({ headless: true });
  return { sessionId: browser.session_id };
};
```

The helper binds only to `127.0.0.1` on an OS-assigned port, uses Lambda's
`/tmp` for its registry, unrefs the listener, and caches the startup promise at
module scope. The Lambda still needs outbound HTTPS access to Arker and, when
hybrid routing is enabled, Kernel. Use a hosted proxy when sessions or
capability URLs must be shared across concurrent Lambda execution environments;
each embedded environment has isolated `/tmp` state and signing keys.

## Customize browser setup

```bash
cp node_modules/@arker-ai/sdk/scripts/kernel-proxy/setup-cloakbrowser.sh ./setup-browser.sh
chmod +x ./setup-browser.sh
arker-kernel-proxy --setup-script "$PWD/setup-browser.sh" ...
```

The JSON config path is the script's first argument. Preserve the documented
runtime directory and service ports unless the proxy is updated with matching
values. Supported pins are:

| Variable | Purpose | Default |
| --- | --- | --- |
| `NODE_VERSION` | Node installed when the source has Node <20 | `22.23.0` |
| `CLOAKBROWSER_NPM_VERSION` | CloakBrowser npm wrapper | `0.5.5` |
| `CLOAKBROWSER_VERSION` | CloakBrowser binary | `146.0.7680.177.5` |
| `CLOAKBROWSER_LICENSE_KEY` | Optional licensed-binary key | unset |
| `PLAYWRIGHT_VERSION` | guest Playwright Core | `1.62.0` |

The SDK does not redistribute CloakBrowser binaries; the setup script downloads
them into the caller's VM. Review CloakBrowser's
[binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)
before deployment.

## Compatibility matrix

| Kernel surface | Status | Notes |
| --- | --- | --- |
| Browser lifecycle | Supported | create, list, retrieve, update, delete, pagination, timeouts, viewport, kiosk, policy, headed/headless |
| CDP and WebDriver BiDi | Supported | capability-authenticated WebSocket bridges |
| Browser live view | Supported | noVNC for headed sessions |
| Process and PTY | Supported | exec, spawn, stdin, resize, status, signals, output streams |
| Filesystem and watch | Supported | file CRUD, upload/download, ZIP handling, recursive watch streams |
| Playwright and browser fetch | Supported | persistent runner plus Chrome-network-stack requests |
| Computer control | Supported | screenshots, mouse, keyboard, navigation, clipboard, cursor, batch |
| Extensions and profiles | Supported | CRUD, archive round trips, attach/update, optional saved changes |
| Custom proxies | Supported | credential redaction, health checks, runtime attach/remove, CA trust |
| Browser pools | Supported | CRUD, fill, acquire, release/reuse/discard, flush, force delete |
| Logs, telemetry, and replays | Supported | bounded streams/journals and headed audio/video capture |
| GPU browser | Unsupported | requires a compatible prepared browser source |
| Kernel-managed proxy inventory | Unsupported | no equivalent managed inventory |
| Apps, deployments, invocations, managed auth, credentials, projects, org administration, API keys, audit logs | Out of scope | separate control plane |

Unknown routes and unavailable capabilities return structured Kernel-style
errors instead of silently falling back.

## Validation

Local regression:

```bash
npm test
npm run typecheck
bash -n scripts/kernel-proxy/setup-cloakbrowser.sh
python3 -m py_compile tests/kernel-proxy-live.py
```

Live tests create temporary resources and require a prepared source:

```bash
export ARKER_API_KEY=...
export KERNEL_PROXY_ARKER_SOURCE_ID=vmh-...

KERNEL_PROXY_LIVE_PYTHON=/path/to/python bun tests/kernel-proxy-live.ts
KERNEL_PROXY_LIVE_HEADED=1 \
  KERNEL_PROXY_LIVE_PYTHON=/path/to/python \
  bun tests/kernel-proxy-live.ts
bun tests/kernel-proxy-control-live.ts
KERNEL_PROXY_STANDBY_CYCLES=12 bun tests/kernel-proxy-standby-live.ts
KERNEL_PROXY_BENCH_MEMORY_MIB=512 \
  KERNEL_PROXY_BENCH_STRESS=true \
  bun tests/kernel-proxy-benchmark.ts
```

The live suites cover the supported REST surface, official TypeScript and
Python clients, capability URLs, headed and headless browser paths, repeated
standby/resume, restart persistence, concurrency, and exact cleanup of resources
created by the test run.

## Operational differences

- Browser deletion removes the corresponding Arker VM immediately.
- In-flight streams and controllers belong to one proxy process; persisted
  browser metadata and control-resource records survive restart.
- Run one active proxy process per state directory.
- Hybrid percentages apply to new browser sessions, not individual requests;
  switching a live browser between providers would lose its state.
- A prepared source must stay running for warm process-preserving forks.
- Runtime profile or proxy changes restart the browser; clients should use the
  refreshed connection URLs returned by the proxy.
- Pooled profiles are read-only, matching Kernel's reuse behavior.
- Direct VM egress is the default; Kernel's managed proxy inventory is not
  reproduced.
- Chrome policy keys that would disable or replace proxy-owned capabilities are
  rejected.
