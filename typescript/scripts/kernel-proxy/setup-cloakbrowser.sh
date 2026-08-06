#!/usr/bin/env bash
set -Eeuo pipefail

# Editable Arker Kernel-compat browser image setup.
#
# The proxy copies this script into each freshly forked VM and runs it once.
# Override it with KERNEL_PROXY_SETUP_SCRIPT=/absolute/path/to/script.sh.
# The JSON configuration path is passed as $1.

CONFIG_PATH="${1:-/opt/arker-kernel/config.json}"
INSTALL_ROOT="/opt/arker-kernel"
CLOAK_NPM_VERSION="${CLOAKBROWSER_NPM_VERSION:-0.5.5}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.62.0}"
NODE_VERSION="${NODE_VERSION:-22.23.0}"
SETUP_FINGERPRINT="${KERNEL_PROXY_SETUP_FINGERPRINT:-}"
REPAIR_RUNTIME="${KERNEL_PROXY_REPAIR_RUNTIME:-false}"

export DEBIAN_FRONTEND=noninteractive

# Full repair restores dpkg's latest backup and rebuilds package indexes when
# an interrupted package operation leaves the status database unreadable.
if [[ "$REPAIR_RUNTIME" == "full" ]] && ! dpkg-query -W >/dev/null 2>&1; then
  if [[ -s /var/backups/dpkg.status.0 ]]; then
    install -m 644 /var/backups/dpkg.status.0 /var/lib/dpkg/status
  fi
  find /var/lib/apt/lists -mindepth 1 -type f -delete 2>/dev/null || true
  find /var/lib/apt/lists -mindepth 1 -type l -delete 2>/dev/null || true
  find /var/lib/apt/lists -depth -mindepth 1 -type d -empty -delete 2>/dev/null || true
  dpkg --configure -a || true
fi

mkdir -p "$INSTALL_ROOT" /var/log/arker-kernel /var/lib/arker-kernel /run/arker-kernel
chmod 700 "$INSTALL_ROOT"
# Keep the exact editable installer on the prepared source. Matching memory
# forks can invoke this durable copy after uploading only their tiny JSON
# config; a changed proxy fingerprint deliberately falls back to uploading the
# new script before it is trusted.
if [[ "$(readlink -f "$0")" != "$INSTALL_ROOT/setup-cloakbrowser.sh" ]]; then
  install -m 700 "$0" "$INSTALL_ROOT/setup-cloakbrowser.sh"
fi
CONFIG_UNCHANGED=false
if [[ "$CONFIG_PATH" != "$INSTALL_ROOT/config.json" ]]; then
  if [[ -f "$INSTALL_ROOT/config.json" ]] && cmp -s "$CONFIG_PATH" "$INSTALL_ROOT/config.json"; then
    CONFIG_UNCHANGED=true
  fi
  install -m 600 "$CONFIG_PATH" "$INSTALL_ROOT/config.json"
  CONFIG_PATH="$INSTALL_ROOT/config.json"
fi

PREPARED_RUNTIME=false
if [[ "$REPAIR_RUNTIME" == "false" ]] \
    && [[ -n "$SETUP_FINGERPRINT" ]] \
    && [[ "$(cat "$INSTALL_ROOT/.setup-fingerprint" 2>/dev/null || true)" == "$SETUP_FINGERPRINT" ]] \
    && [[ -x "$INSTALL_ROOT/start-services.sh" ]]; then
  PREPARED_RUNTIME=true
fi

if [[ "$REPAIR_RUNTIME" != "assets" && "$PREPARED_RUNTIME" != "true" ]]; then
  apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=40 update
  apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=40 install -y --no-install-recommends \
    ca-certificates curl dbus-x11 ffmpeg fonts-dejavu-core fonts-liberation \
    inotify-tools jq libnss3-tools novnc openbox procps pulseaudio python3 scrot unzip websockify x11-utils \
    x11-xserver-utils x11vnc xclip xdotool xserver-xorg-core xvfb util-linux xz-utils
fi

# Smaller Arker goldens can ship Node 18, while current CloakBrowser and
# Playwright require Node 20+. Install a pinned official LTS binary and verify
# it against Node's published SHA-256 manifest before npm is used.
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)
if [[ "$REPAIR_RUNTIME" != "assets" && "$NODE_MAJOR" -lt 20 ]]; then
  case "$(uname -m)" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) echo "Unsupported Node.js architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  NODE_BASENAME="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  NODE_DOWNLOAD_DIR=$(mktemp -d)
  curl -fsSL --retry 3 --connect-timeout 20 \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_BASENAME}.tar.xz" \
    -o "$NODE_DOWNLOAD_DIR/$NODE_BASENAME.tar.xz"
  curl -fsSL --retry 3 --connect-timeout 20 \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    -o "$NODE_DOWNLOAD_DIR/SHASUMS256.txt"
  (
    cd "$NODE_DOWNLOAD_DIR"
    grep "  ${NODE_BASENAME}.tar.xz$" SHASUMS256.txt | sha256sum -c -
  )
  tar -xJf "$NODE_DOWNLOAD_DIR/$NODE_BASENAME.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$NODE_DOWNLOAD_DIR"
fi

# Arker's stock /tmp can be runtime-ephemeral across idle suspension. Kernel
# sessions expect filesystem and process-created /tmp paths to survive standby,
# so expose a disk-backed directory at the conventional path.
PERSISTENT_TMP="/var/lib/arker-kernel/tmp"
install -d -m 1777 "$PERSISTENT_TMP"
touch "$PERSISTENT_TMP/.arker-persistent-tmp"
if [[ ! -e /tmp/.arker-persistent-tmp ]]; then
  mount --bind "$PERSISTENT_TMP" /tmp
fi
chmod 1777 /tmp

# `ubuntu-small` has a 512 MiB floor. A disk-backed swap file gives Chromium's
# least-recently-used anonymous pages somewhere to go instead of letting one
# renderer OOM the persistent browser shell. This is enabled only for the
# explicit low-memory configuration and is inherited by warm-memory forks.
if [[ "$(jq -r '.lowMemoryMode // false' "$CONFIG_PATH")" == "true" ]]; then
  SWAP_PATH="/var/lib/arker-kernel/browser.swap"
  if [[ ! -f "$SWAP_PATH" ]] || [[ "$(stat -c %s "$SWAP_PATH" 2>/dev/null || printf 0)" -ne 536870912 ]]; then
    swapoff "$SWAP_PATH" >/dev/null 2>&1 || true
    rm -f "$SWAP_PATH"
    fallocate -l 512M "$SWAP_PATH"
    chmod 600 "$SWAP_PATH"
    mkswap "$SWAP_PATH" >/dev/null
  fi
  if ! swapon --noheadings --show=NAME 2>/dev/null | awk '{$1=$1};1' | grep -Fx "$SWAP_PATH" >/dev/null; then
    swapon "$SWAP_PATH"
  fi
fi

# Apply session-specific durable inputs before starting (or fast-restarting)
# browser services. The archive fields are one-shot and are removed from the
# persisted config after successful extraction so runtime repair cannot roll a
# profile back to its creation-time state.
PROFILE_PATH=$(jq -r '.profilePath // "/var/lib/arker-kernel/profile"' "$CONFIG_PATH")
if [[ "$(jq -r '.profileReset // false' "$CONFIG_PATH")" == "true" ]]; then
  pkill -TERM -f '[/]opt/arker-kernel/start-browser.mjs' 2>/dev/null || true
  pkill -TERM -f '[/]opt/arker-kernel/playwright-runner.mjs' 2>/dev/null || true
  pkill -TERM -x chromedriver 2>/dev/null || true
  for _ in $(seq 1 100); do
    pgrep -f -- "--user-data-dir=$PROFILE_PATH" >/dev/null || break
    sleep 0.1
  done
  pkill -KILL -f '[/]opt/arker-kernel/start-browser.mjs' 2>/dev/null || true
  pkill -KILL -f '[/]opt/arker-kernel/playwright-runner.mjs' 2>/dev/null || true
  pkill -KILL -x chromedriver 2>/dev/null || true
  pkill -KILL -f -- "--user-data-dir=$PROFILE_PATH" 2>/dev/null || true
  for _ in $(seq 1 50); do
    pgrep -f -- "--user-data-dir=$PROFILE_PATH" >/dev/null || break
    sleep 0.1
  done
  for _ in $(seq 1 20); do
    rm -rf "$PROFILE_PATH" 2>/dev/null && break
    sleep 0.1
  done
  [[ ! -e "$PROFILE_PATH" ]] || { echo "Unable to reset active browser profile $PROFILE_PATH" >&2; exit 1; }
  install -d -m 700 "$PROFILE_PATH"
fi

PROFILE_ARCHIVE=$(jq -r '.profileArchivePath // empty' "$CONFIG_PATH")
if [[ -n "$PROFILE_ARCHIVE" ]]; then
  python3 - "$PROFILE_ARCHIVE" "$PROFILE_PATH" <<'ARKER_KERNEL_PROFILE_EXTRACT'
import os
import sys
import tarfile

archive, destination = sys.argv[1:]
os.makedirs(destination, exist_ok=True)
with tarfile.open(archive, "r:*") as bundle:
    bundle.extractall(destination, filter="data")
ARKER_KERNEL_PROFILE_EXTRACT
  rm -f "$PROFILE_ARCHIVE"
fi

EXTENSION_IMPORTS=$(mktemp)
jq -r '.extensionArchives[]? | [.archivePath, .destination] | @tsv' "$CONFIG_PATH" >"$EXTENSION_IMPORTS"
while IFS=$'\t' read -r ARCHIVE_PATH EXTENSION_PATH; do
  [[ -n "$ARCHIVE_PATH" && -n "$EXTENSION_PATH" ]] || continue
  rm -rf "$EXTENSION_PATH"
  python3 - "$ARCHIVE_PATH" "$EXTENSION_PATH" <<'ARKER_KERNEL_EXTENSION_EXTRACT'
import os
import sys
import zipfile

archive, destination = sys.argv[1:]
destination = os.path.realpath(destination)
os.makedirs(destination, exist_ok=True)
with zipfile.ZipFile(archive) as bundle:
    for member in bundle.infolist():
        target = os.path.realpath(os.path.join(destination, member.filename))
        if target != destination and not target.startswith(destination + os.sep):
            raise ValueError("unsafe zip member: " + member.filename)
    bundle.extractall(destination)
ARKER_KERNEL_EXTENSION_EXTRACT
  rm -f "$ARCHIVE_PATH"
done <"$EXTENSION_IMPORTS"
rm -f "$EXTENSION_IMPORTS"

install -d -m 700 "$INSTALL_ROOT/extensions"
if jq -e '.proxy.username | type == "string"' "$CONFIG_PATH" >/dev/null 2>&1; then
  PROXY_AUTH_PATH=$(jq -r --arg fallback "$INSTALL_ROOT/extensions/proxy-auth" '.proxy.extensionPath // $fallback' "$CONFIG_PATH")
  case "$PROXY_AUTH_PATH" in
    "$INSTALL_ROOT"/extensions/proxy-auth*) ;;
    *) echo "Invalid proxy authentication extension path" >&2; exit 1 ;;
  esac
  find "$INSTALL_ROOT/extensions" -mindepth 1 -maxdepth 1 -type d -name 'proxy-auth*' \
    ! -path "$PROXY_AUTH_PATH" -exec rm -rf -- {} +
  install -d -m 700 "$PROXY_AUTH_PATH"
  cat >"$PROXY_AUTH_PATH/manifest.json" <<'ARKER_KERNEL_PROXY_MANIFEST'
{"manifest_version":3,"name":"Arker Kernel Proxy Authentication","version":"1.0.0","permissions":["webRequest","webRequestAuthProvider"],"host_permissions":["<all_urls>"],"background":{"service_worker":"background.js"}}
ARKER_KERNEL_PROXY_MANIFEST
  printf 'const credentials = ' >"$PROXY_AUTH_PATH/background.js"
  jq -c '{username: .proxy.username, password: (.proxy.password // "")}' "$CONFIG_PATH" >>"$PROXY_AUTH_PATH/background.js"
  cat >>"$PROXY_AUTH_PATH/background.js" <<'ARKER_KERNEL_PROXY_BACKGROUND'
;
chrome.webRequest.onAuthRequired.addListener(
  (_details, callback) => callback({ authCredentials: credentials }),
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);
ARKER_KERNEL_PROXY_BACKGROUND
  chmod 600 "$PROXY_AUTH_PATH/manifest.json" "$PROXY_AUTH_PATH/background.js"
else
  find "$INSTALL_ROOT/extensions" -mindepth 1 -maxdepth 1 -type d -name 'proxy-auth*' \
    -exec rm -rf -- {} +
fi

if jq -e '.proxy.caBundle | type == "string" and length > 0' "$CONFIG_PATH" >/dev/null 2>&1; then
  jq -r '.proxy.caBundle' "$CONFIG_PATH" > /usr/local/share/ca-certificates/arker-kernel-proxy.crt
  chmod 600 /usr/local/share/ca-certificates/arker-kernel-proxy.crt
  update-ca-certificates >/dev/null
  install -d -m 700 /root/.pki/nssdb
  certutil -d sql:/root/.pki/nssdb -N --empty-password >/dev/null 2>&1 || true
  certutil -d sql:/root/.pki/nssdb -D -n arker-kernel-proxy >/dev/null 2>&1 || true
  certutil -d sql:/root/.pki/nssdb -A -n arker-kernel-proxy -t 'C,,' \
    -i /usr/local/share/ca-certificates/arker-kernel-proxy.crt
else
  if [[ -e /usr/local/share/ca-certificates/arker-kernel-proxy.crt ]]; then
    rm -f /usr/local/share/ca-certificates/arker-kernel-proxy.crt
    update-ca-certificates >/dev/null
  fi
  if [[ -d /root/.pki/nssdb ]]; then
    certutil -d sql:/root/.pki/nssdb -D -n arker-kernel-proxy >/dev/null 2>&1 || true
  fi
fi

if jq -e 'has("profileArchivePath") or has("extensionArchives") or .profileReset == true' "$CONFIG_PATH" >/dev/null; then
  CLEAN_CONFIG=$(mktemp)
  jq 'del(.profileArchivePath, .extensionArchives) | .profileReset = false' "$CONFIG_PATH" >"$CLEAN_CONFIG"
  install -m 600 "$CLEAN_CONFIG" "$CONFIG_PATH"
  rm -f "$CLEAN_CONFIG"
fi

write_prepared_runtime_manifest() {
  local cdp_url bidi_url config_sha256 manifest_tmp
  cdp_url=$(curl -fsS --max-time 5 http://127.0.0.1:9222/json/version | jq -r '.webSocketDebuggerUrl')
  bidi_url=$(jq -r '.value.capabilities.webSocketUrl' /run/arker-kernel/webdriver.json)
  config_sha256=$(sha256sum "$CONFIG_PATH" | awk '{print $1}')
  manifest_tmp=$(mktemp)
  jq -Mnc \
    --arg setup_fingerprint "$SETUP_FINGERPRINT" \
    --arg config_sha256 "$config_sha256" \
    --arg cdp "$cdp_url" \
    --arg bidi "$bidi_url" \
    '{version:1,setup_fingerprint:$setup_fingerprint,config_sha256:$config_sha256,cdp:$cdp,bidi:$bidi}' \
    >"$manifest_tmp"
  install -m 600 "$manifest_tmp" "$INSTALL_ROOT/prepared-runtime.json"
  rm -f "$manifest_tmp"
}

# Chrome reads managed policy JSON at startup. Kernel blocks automation-owned
# policy names; the proxy leaves validation to Chrome and preserves the exact
# caller-supplied object in the browser response.
mkdir -p /etc/opt/chrome/policies/managed
jq '.chromePolicy // {}' "$CONFIG_PATH" >/etc/opt/chrome/policies/managed/arker-kernel.json
chmod 644 /etc/opt/chrome/policies/managed/arker-kernel.json

# A prepared source can carry the installed stack and live process
# memory. If its setup fingerprint and requested config both match, the forked
# browser is already ready; if only the config changed, restart services
# without repeating apt/npm/ChromeDriver installation.
if [[ "$REPAIR_RUNTIME" == "false" ]] \
    && [[ -n "$SETUP_FINGERPRINT" ]] \
    && [[ "$(cat "$INSTALL_ROOT/.setup-fingerprint" 2>/dev/null || true)" == "$SETUP_FINGERPRINT" ]] \
    && [[ -x "$INSTALL_ROOT/start-services.sh" ]]; then
  if [[ "$CONFIG_UNCHANGED" == true ]] \
      && curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 \
      && curl -fsS --max-time 2 http://127.0.0.1:9230/health >/dev/null 2>&1 \
      && jq -e '.value.capabilities.webSocketUrl | type == "string"' /run/arker-kernel/webdriver.json >/dev/null 2>&1; then
    write_prepared_runtime_manifest
    echo prepared_browser_ready
    exit 0
  fi
  "$INSTALL_ROOT/start-services.sh" "$CONFIG_PATH"
  write_prepared_runtime_manifest
  exit 0
fi

cd "$INSTALL_ROOT"
if [[ "$REPAIR_RUNTIME" != "assets" ]]; then
  if [[ ! -f package.json ]]; then
    npm init -y >/dev/null
  fi
  npm install --omit=dev --no-audit --no-fund \
    "cloakbrowser@${CLOAK_NPM_VERSION}" \
    "playwright-core@${PLAYWRIGHT_VERSION}"

  # Playwright owns the authoritative Chromium shared-library dependency list.
  # CloakBrowser supplies its own browser binary, so install only OS deps.
  npx --yes playwright-core install-deps chromium

  # CloakBrowser is Chromium-based but ships outside Chrome for Testing. Match
  # ChromeDriver by MAJOR.MINOR.BUILD as required by Chrome's official version
  # selection guidance; the final patch component may legitimately differ.
  CHROME_BUILD=$(jq -r '.cloakbrowserBinaryVersion // "146.0.7680.177.5"' "$CONFIG_PATH" | cut -d. -f1-3)
  CFT_MANIFEST=$(mktemp)
  curl -fsSL --retry 3 --connect-timeout 20 \
    https://googlechromelabs.github.io/chrome-for-testing/latest-patch-versions-per-build-with-downloads.json \
    -o "$CFT_MANIFEST"
  CHROMEDRIVER_URL=$(jq -r --arg build "$CHROME_BUILD" \
    '.builds[$build].downloads.chromedriver[]? | select(.platform == "linux64") | .url' \
    "$CFT_MANIFEST" | head -1)
  rm -f "$CFT_MANIFEST"
  if [[ -z "$CHROMEDRIVER_URL" ]]; then
    echo "No ChromeDriver linux64 build matches CloakBrowser build $CHROME_BUILD" >&2
    exit 1
  fi
  CHROMEDRIVER_ZIP=$(mktemp)
  CHROMEDRIVER_DIR=$(mktemp -d)
  curl -fsSL --retry 3 --connect-timeout 20 "$CHROMEDRIVER_URL" -o "$CHROMEDRIVER_ZIP"
  unzip -q "$CHROMEDRIVER_ZIP" -d "$CHROMEDRIVER_DIR"
  install -m 755 "$CHROMEDRIVER_DIR/chromedriver-linux64/chromedriver" /usr/local/bin/chromedriver
  rm -f "$CHROMEDRIVER_ZIP"
  rm -rf "$CHROMEDRIVER_DIR"
fi

cat > "$INSTALL_ROOT/start-browser.mjs" <<'ARKER_KERNEL_BROWSER'
import { readFile } from "node:fs/promises";
import { launchPersistentContext } from "cloakbrowser";

const configPath = process.argv[2] || "/opt/arker-kernel/config.json";
const config = JSON.parse(await readFile(configPath, "utf8"));

const width = Number(config.viewport?.width || 1920);
const height = Number(config.viewport?.height || 1080);
const browserVersion = config.cloakbrowserLicenseKey
  ? (config.cloakbrowserBinaryVersion || undefined)
  : (config.cloakbrowserBinaryVersion || "146.0.7680.177.5");
const extensionPaths = (Array.isArray(config.browserArgs) ? config.browserArgs : [])
  .filter((argument) => typeof argument === "string" && argument.startsWith("--load-extension="))
  .flatMap((argument) => argument.slice(argument.indexOf("=") + 1).split(","))
  .filter(Boolean);
const ignoreDefaultArgs = [
  "--enable-automation",
  "--enable-unsafe-swiftshader",
  // Playwright's Chromium defaults mute the audio service. Headed Kernel
  // replays capture the PulseAudio monitor, so the browser must emit samples.
  "--mute-audio",
  // Playwright injects --disable-extensions by default. CloakBrowser's
  // extensionPaths adds the allow/load switches but does not remove that
  // contradictory default, leaving proxy-auth and stored extensions inert.
  ...(extensionPaths.length ? ["--disable-extensions"] : []),
];

const context = await launchPersistentContext({
  userDataDir: config.profilePath || "/var/lib/arker-kernel/profile",
  headless: Boolean(config.headless),
  stealthArgs: config.stealth !== false,
  browserVersion,
  licenseKey: config.cloakbrowserLicenseKey || undefined,
  viewport: config.headless ? { width, height } : null,
  ...(extensionPaths.length ? { extensionPaths } : {}),
  args: [
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-features=PaintHolding,BackForwardCache",
    // Kernel profiles must move between independent VM forks. Chromium's
    // desktop-keyring backend binds encrypted cookies to a guest/session key;
    // the basic backend uses Chromium's portable Linux profile encryption.
    "--password-store=basic",
    "--remote-allow-origins=*",
    "--remote-debugging-address=0.0.0.0",
    "--remote-debugging-port=9222",
    `--window-size=${width},${height}`,
    ...(config.lowMemoryMode ? [
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-sync",
      "--disk-cache-size=16777216",
      "--media-cache-size=16777216",
      "--renderer-process-limit=2",
      "--js-flags=--max-old-space-size=128",
    ] : []),
    ...(Array.isArray(config.browserArgs) ? config.browserArgs : []),
  ],
  launchOptions: {
    handleSIGHUP: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    ignoreDefaultArgs,
  },
});

const page = context.pages()[0] || await context.newPage();
if (config.startUrl) {
  page.goto(config.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
}

const shutdown = async () => {
  await context.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", () => {});
setInterval(() => {}, 2 ** 30);
ARKER_KERNEL_BROWSER

cat > "$INSTALL_ROOT/playwright-runner.mjs" <<'ARKER_KERNEL_PLAYWRIGHT'
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { appendFile, open, readFile, stat, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const playwright = require("playwright-core");
const { chromium } = playwright;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const configPath = process.argv[2] || "/opt/arker-kernel/config.json";
const config = JSON.parse(await readFile(configPath, "utf8"));
const telemetryPath = "/var/lib/arker-kernel/telemetry.jsonl";
const telemetryConfig = config.telemetry?.browser || {};
const maxTelemetryEvents = config.lowMemoryMode ? 2_000 : 10_000;
const maxTelemetryBytes = (config.lowMemoryMode ? 16 : 64) * 1024 * 1024;
const maxTelemetryEventBytes = 8 * 1024 * 1024;
let telemetryEvents = [];
let telemetryBytes = 0;
let nextTelemetrySequence = 1;
let telemetryWrite = Promise.resolve();
try {
  const info = await stat(telemetryPath);
  const start = Math.max(0, info.size - maxTelemetryBytes);
  const handle = await open(telemetryPath, "r");
  const tail = Buffer.alloc(info.size - start);
  await handle.read(tail, 0, tail.length, start);
  await handle.close();
  const text = tail.toString("utf8");
  const lines = (start ? text.slice(text.indexOf("\n") + 1) : text).split("\n").filter(Boolean);
  telemetryEvents = lines.slice(-maxTelemetryEvents).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  telemetryBytes = telemetryEvents.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
  while (telemetryEvents.length && telemetryBytes > maxTelemetryBytes) {
    telemetryBytes -= Buffer.byteLength(JSON.stringify(telemetryEvents.shift())) + 1;
  }
  nextTelemetrySequence = Math.max(0, ...telemetryEvents.map((item) => Number(item.seq) || 0)) + 1;
} catch {}

function categoryEnabled(category) {
  if (category === "monitor") return ["console", "network", "page", "interaction"].some((name) => telemetryConfig[name]?.enabled);
  return telemetryConfig[category]?.enabled === true;
}

function emitTelemetry(category, type, data, source = { kind: "cdp", event: `Playwright.${type}` }) {
  if (!categoryEnabled(category)) return;
  let envelope = {
    seq: nextTelemetrySequence++,
    event: {
      ts: Date.now() * 1_000,
      type,
      category,
      source,
      ...(data === undefined ? {} : { data }),
    },
  };
  let serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > maxTelemetryEventBytes) {
    envelope = {
      seq: envelope.seq,
      event: { ...envelope.event, data: { truncated: true, reason: "telemetry event exceeded 8 MiB" } },
    };
    serialized = JSON.stringify(envelope);
  }
  telemetryEvents.push(envelope);
  telemetryBytes += Buffer.byteLength(serialized) + 1;
  let compact = false;
  while (telemetryEvents.length > maxTelemetryEvents || telemetryBytes > maxTelemetryBytes) {
    telemetryBytes -= Buffer.byteLength(JSON.stringify(telemetryEvents.shift())) + 1;
    compact = true;
  }
  telemetryWrite = telemetryWrite.then(async () => {
    await appendFile(telemetryPath, `${serialized}\n`);
    if (compact || (envelope.seq % 1_000 === 0 && telemetryEvents.length === maxTelemetryEvents)) {
      await writeFile(telemetryPath, `${telemetryEvents.map(JSON.stringify).join("\n")}\n`);
    }
  }).catch(() => {});
}

let browser;
let queue = Promise.resolve();
const monitoredContexts = new WeakSet();
const monitoredPages = new WeakSet();
const networkState = new WeakMap();

function pageContext(page) {
  return { url: page.url(), target_type: "page" };
}

function settleNetwork(page) {
  const state = networkState.get(page);
  if (!state || state.inflight !== 0) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => emitTelemetry("network", "network_idle", pageContext(page)), 500);
}

async function drainPageTelemetry(page) {
  const pending = await page.evaluate(() => {
    const state = globalThis.__arkerTelemetryQueueState;
    if (!state || !Array.isArray(state.events)) return [];
    return state.events.splice(0, state.events.length);
  }).catch(() => []);
  for (const payload of pending) {
    if (!payload || typeof payload !== "object") continue;
    const type = String(payload.type || "interaction_click");
    if (type === "console_log" || type === "console_error") {
      emitTelemetry("console", type, payload.data || {}, { kind: "extension", event: type });
    } else {
      emitTelemetry("interaction", type, payload.data || {}, { kind: "extension", event: type });
    }
  }
}

async function monitorPage(page, opened = false) {
  if (monitoredPages.has(page)) return;
  monitoredPages.add(page);
  networkState.set(page, { inflight: 0, timer: undefined });
  for (const method of ["goto", "reload", "goBack", "goForward", "setContent", "close"]) {
    const original = page[method]?.bind(page);
    if (!original) continue;
    page[method] = async (...args) => {
      await drainPageTelemetry(page);
      return original(...args);
    };
  }
  const drainTimer = setInterval(() => void drainPageTelemetry(page), 250);
  drainTimer.unref?.();
  page.once("close", () => clearInterval(drainTimer));
  if (opened) emitTelemetry("page", "page_tab_opened", pageContext(page));
  const cdp = await page.context().newCDPSession(page).catch(() => undefined);
  const requests = new Map();
  cdp?.on("Runtime.consoleAPICalled", (event) => {
    const values = (event.args || []).map((arg) => arg.value ?? arg.description ?? arg.type);
    const level = String(event.type || "log");
    emitTelemetry("console", ["error", "assert"].includes(level) ? "console_error" : "console_log", {
      ...pageContext(page), level, text: values.map(String).join(" "), args: values,
    }, { kind: "cdp", event: "Runtime.consoleAPICalled" });
  });
  cdp?.on("Runtime.exceptionThrown", (event) => emitTelemetry("console", "console_error", {
    ...pageContext(page), text: String(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "Uncaught exception"),
  }, { kind: "cdp", event: "Runtime.exceptionThrown" }));
  cdp?.on("Network.requestWillBeSent", (event) => {
    const state = networkState.get(page);
    if (state) { state.inflight += 1; clearTimeout(state.timer); }
    requests.set(event.requestId, { method: event.request.method, resource_type: event.type, url: event.request.url });
    emitTelemetry("network", "network_request", {
      ...pageContext(page), method: event.request.method, resource_type: event.type, url: event.request.url, post_data: event.request.postData,
    }, { kind: "cdp", event: "Network.requestWillBeSent" });
  });
  cdp?.on("Network.responseReceived", (event) => emitTelemetry("network", "network_response", {
    ...pageContext(page), method: requests.get(event.requestId)?.method, resource_type: event.type,
    status: event.response.status, status_text: event.response.statusText, url: event.response.url,
  }, { kind: "cdp", event: "Network.loadingFinished" }));
  const requestDone = (requestId, failed, errorText) => {
    const state = networkState.get(page);
    if (state) state.inflight = Math.max(0, state.inflight - 1);
    const request = requests.get(requestId) || {};
    if (failed) emitTelemetry("network", "network_loading_failed", {
      ...pageContext(page), ...request, error_text: errorText,
    }, { kind: "cdp", event: "Network.loadingFailed" });
    requests.delete(requestId);
    settleNetwork(page);
  };
  cdp?.on("Network.loadingFinished", (event) => requestDone(event.requestId, false));
  cdp?.on("Network.loadingFailed", (event) => requestDone(event.requestId, true, event.errorText));
  await Promise.all([
    cdp?.send("Runtime.enable"),
    cdp?.send("Network.enable"),
    cdp?.send("Page.enable"),
  ].filter(Boolean)).catch(() => {});
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    emitTelemetry("page", "page_navigation", { ...pageContext(page), url: frame.url() }, { kind: "cdp", event: "Page.frameNavigated" });
  });
  page.on("domcontentloaded", () => emitTelemetry("page", "page_dom_content_loaded", pageContext(page), { kind: "cdp", event: "Page.domContentEventFired" }));
  page.on("load", () => {
    emitTelemetry("page", "page_load", pageContext(page), { kind: "cdp", event: "Page.loadEventFired" });
    setTimeout(() => {
      emitTelemetry("page", "page_layout_settled", pageContext(page), { kind: "extension", event: "layout_settled" });
      emitTelemetry("page", "page_navigation_settled", pageContext(page), { kind: "extension", event: "navigation_settled" });
    }, 1_000);
  });
}

async function monitorContext(context) {
  if (monitoredContexts.has(context)) return;
  monitoredContexts.add(context);
  const installInteractions = () => {
    const stateKey = "__arkerTelemetryQueueState";
    const existing = globalThis[stateKey];
    const state = existing && Array.isArray(existing.events) ? existing : { events: [], installed: false };
    globalThis[stateKey] = state;
    const firstInstall = !state.installed;
    state.installed = true;
    const send = (type, data) => {
      const current = globalThis[stateKey];
      if (current && Array.isArray(current.events)) current.events.push({ type, data });
    };
    for (const level of ["log", "debug", "info", "warn", "error"]) {
      const current = console[level];
      if (current?.__arkerTelemetryWrapped) continue;
      const original = current?.bind(console);
      if (!original) continue;
      const wrapped = (...args) => {
        const values = args.map((value) => {
          try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); }
        });
        void send(level === "error" ? "console_error" : "console_log", { level, text: values.join(" "), args: values });
        return original(...args);
      };
      Object.defineProperty(wrapped, "__arkerTelemetryWrapped", { value: true });
      try { Object.defineProperty(console, level, { configurable: true, writable: true, value: wrapped }); }
      catch { console[level] = wrapped; }
    }
    if (!firstInstall) return;
    globalThis.addEventListener?.("error", (event) => {
      void send("console_error", { level: "error", text: String(event.error?.message || event.message || "Uncaught exception") });
    });
    globalThis.addEventListener?.("unhandledrejection", (event) => {
      void send("console_error", { level: "error", text: String(event.reason?.message || event.reason || "Unhandled promise rejection") });
    });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      void send("interaction_click", { x: event.clientX, y: event.clientY, tag: target?.tagName, text: target?.textContent?.trim().slice(0, 500) });
    }, true);
    document.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      void send("interaction_key", { key: event.key, tag: target?.tagName });
    }, true);
    let scrollTimer;
    let fromX = scrollX;
    let fromY = scrollY;
    document.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        void send("interaction_scroll_settled", { from_x: fromX, from_y: fromY, to_x: scrollX, to_y: scrollY });
        fromX = scrollX; fromY = scrollY;
      }, 250);
    }, true);
  };
  const monitor = async (page, opened) => {
    page.on("domcontentloaded", () => void page.evaluate(installInteractions).catch(() => {}));
    await monitorPage(page, opened);
    await page.evaluate(installInteractions).catch(() => {});
  };
  await context.addInitScript(installInteractions);
  context.on("page", (page) => void monitor(page, true));
  for (const page of context.pages()) {
    await monitor(page, false);
  }
  if (categoryEnabled("screenshot")) {
    const capture = async () => {
      const page = context.pages().find((candidate) => !candidate.isClosed());
      if (!page) return;
      const png = await page.screenshot({ type: "png" }).catch(() => undefined);
      if (png) emitTelemetry("screenshot", "monitor_screenshot", { png: Buffer.from(png).toString("base64") }, { kind: "local_process", event: "periodic_screenshot" });
    };
    setInterval(() => void capture(), 15_000).unref?.();
  }
}

async function browserState() {
  if (!browser?.isConnected()) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 30_000 });
        break;
      } catch (error) {
        lastError = error;
        browser = undefined;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!browser?.isConnected()) throw lastError || new Error("CloakBrowser CDP connection failed");
  }
  const context = browser.contexts()[0] || await browser.newContext();
  await monitorContext(context);
  const page = context.pages().find((candidate) => !candidate.isClosed()) || await context.newPage();
  return { browser, context, page };
}

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    // The proxy accepts 128 MiB binary direct-fetch bodies. Their base64 JSON
    // envelope is larger, so leave enough room for encoding overhead.
    if (bytes > 192 * 1024 * 1024) throw new Error("request body exceeds 192 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, status, value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    encoded = JSON.stringify({ success: false, error: `Playwright result is not JSON serializable: ${error}` });
  }
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  res.end(encoded);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/telemetry/events") return json(res, 200, { events: telemetryEvents });
  if (req.method !== "POST" || req.url !== "/execute") return json(res, 404, { success: false, error: "not found" });
  const requestStarted = Date.now();
  const requestId = crypto.randomUUID();
  try {
    const request = await body(req);
    const operation = queue.then(async () => {
      const logs = [];
      const errors = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...values) => logs.push(values.map(String).join(" "));
      console.error = (...values) => errors.push(values.map(String).join(" "));
      let timedOut = false;
      let timer;
      try {
        const { page, context, browser } = await browserState();
        const fn = new AsyncFunction("page", "context", "browser", String(request.code || ""));
        const limit = Math.max(1_000, Number(request.timeout_ms || 60_000));
        const result = await Promise.race([
          fn(page, context, browser),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`Playwright execution timed out after ${limit}ms`));
            }, limit);
          }),
        ]);
        return { payload: { success: true, result, stdout: logs.join("\n"), stderr: errors.join("\n") }, timedOut };
      } catch (error) {
        return { payload: { success: false, error: String(error?.stack || error), stdout: logs.join("\n"), stderr: errors.join("\n") }, timedOut };
      } finally {
        if (timer) clearTimeout(timer);
        console.log = originalLog;
        console.error = originalError;
      }
    });
    queue = operation.then(() => undefined, () => undefined);
    const { payload, timedOut } = await operation;
    json(res, 200, payload);
    emitTelemetry("control", "api_call", {
      duration_ms: Date.now() - requestStarted, operation_id: "playwrightExecute", request_id: requestId, status: 200,
    }, { kind: "kernel_api", event: "playwrightExecute" });
    // JavaScript promises cannot be cancelled. A timed-out user function must
    // not retain the serialized runner forever; the proxy starts a clean
    // runner for the next request while CloakBrowser remains alive.
    if (timedOut) setImmediate(() => process.exit(1));
  } catch (error) {
    json(res, 400, { success: false, error: String(error?.stack || error) });
    emitTelemetry("control", "api_call", {
      duration_ms: Date.now() - requestStarted, operation_id: "playwrightExecute", request_id: requestId, status: 400,
    }, { kind: "kernel_api", event: "playwrightExecute" });
  }
});

await browserState().catch((error) => emitTelemetry("monitor", "monitor_init_failed", { error: String(error?.message || error) }, { kind: "local_process", event: "monitor_init" }));
server.listen(9230, "0.0.0.0");
ARKER_KERNEL_PLAYWRIGHT

cat > "$INSTALL_ROOT/start-playwright-runner.sh" <<'ARKER_KERNEL_PLAYWRIGHT_START'
#!/usr/bin/env bash
set -Eeuo pipefail
INSTALL_ROOT="/opt/arker-kernel"
pkill -f "$INSTALL_ROOT/playwright-runner.mjs" 2>/dev/null || true
nohup node "$INSTALL_ROOT/playwright-runner.mjs" "$INSTALL_ROOT/config.json" >>/var/log/arker-kernel/playwright.log 2>&1 &
echo $! >/run/arker-kernel/playwright.pid
for _ in $(seq 1 100); do
  curl -fsS --max-time 1 http://127.0.0.1:9230/health >/dev/null 2>&1 && exit 0
  if ! kill -0 "$(cat /run/arker-kernel/playwright.pid)" 2>/dev/null; then
    tail -100 /var/log/arker-kernel/playwright.log >&2 || true
    exit 1
  fi
  sleep 0.1
done
echo "Playwright runner did not become ready" >&2
exit 1
ARKER_KERNEL_PLAYWRIGHT_START

cat > "$INSTALL_ROOT/start-webdriver.sh" <<'ARKER_KERNEL_WEBDRIVER_START'
#!/usr/bin/env bash
set -Eeuo pipefail
INSTALL_ROOT="/opt/arker-kernel"
pkill -x chromedriver 2>/dev/null || true
rm -f /run/arker-kernel/webdriver.json
nohup /usr/local/bin/chromedriver --port=9515 --allowed-ips= --allowed-origins='*' \
  >>/var/log/arker-kernel/chromedriver.log 2>&1 &
echo $! >/run/arker-kernel/chromedriver.pid
for _ in $(seq 1 100); do
  curl -fsS --max-time 1 http://127.0.0.1:9515/status >/dev/null 2>&1 && break
  if ! kill -0 "$(cat /run/arker-kernel/chromedriver.pid)" 2>/dev/null; then
    tail -100 /var/log/arker-kernel/chromedriver.log >&2 || true
    exit 1
  fi
  sleep 0.1
done
SESSION_REQUEST='{"capabilities":{"alwaysMatch":{"browserName":"chrome","webSocketUrl":true,"goog:chromeOptions":{"debuggerAddress":"127.0.0.1:9222"}}}}'
curl -fsS --max-time 30 -H 'content-type: application/json' \
  --data-binary "$SESSION_REQUEST" http://127.0.0.1:9515/session \
  -o /run/arker-kernel/webdriver.json
if ! jq -e '.value.sessionId | type == "string"' /run/arker-kernel/webdriver.json >/dev/null \
    || ! jq -e '.value.capabilities.webSocketUrl | type == "string"' /run/arker-kernel/webdriver.json >/dev/null; then
  cat /run/arker-kernel/webdriver.json >&2
  exit 1
fi
chmod 600 /run/arker-kernel/webdriver.json
ARKER_KERNEL_WEBDRIVER_START

cat > "$INSTALL_ROOT/start-services.sh" <<'ARKER_KERNEL_SERVICES'
#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_PATH="${1:-/opt/arker-kernel/config.json}"
INSTALL_ROOT="/opt/arker-kernel"
HEADLESS=$(jq -r '.headless // false' "$CONFIG_PATH")
WIDTH=$(jq -r '.viewport.width // 1920' "$CONFIG_PATH")
HEIGHT=$(jq -r '.viewport.height // 1080' "$CONFIG_PATH")
PROFILE_PATH=$(jq -r '.profilePath // "/var/lib/arker-kernel/profile"' "$CONFIG_PATH")

install -d -m 755 /run/arker-kernel /run/dbus
PERSISTENT_TMP="/var/lib/arker-kernel/tmp"
install -d -m 1777 "$PERSISTENT_TMP"
touch "$PERSISTENT_TMP/.arker-persistent-tmp"
if [[ ! -e /tmp/.arker-persistent-tmp ]]; then
  mount --bind "$PERSISTENT_TMP" /tmp
fi
chmod 1777 /tmp

pkill -f "$INSTALL_ROOT/start-browser.mjs" 2>/dev/null || true
pkill -f "$INSTALL_ROOT/playwright-runner.mjs" 2>/dev/null || true
pkill -x chromedriver 2>/dev/null || true
pkill -f 'websockify.*6080' 2>/dev/null || true
pkill -x x11vnc 2>/dev/null || true
pkill -x openbox 2>/dev/null || true
pkill -x Xvfb 2>/dev/null || true
pkill -x pulseaudio 2>/dev/null || true

# The browser launcher closes its persistent context asynchronously on TERM.
# Do not let the next readiness loop observe the old CDP listener and return
# just before it disappears.
for _ in $(seq 1 100); do
  if ! pgrep -f "$INSTALL_ROOT/start-browser.mjs" >/dev/null \
      && ! curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
pkill -KILL -f "$INSTALL_ROOT/start-browser.mjs" 2>/dev/null || true
pkill -KILL -f -- "--user-data-dir=$PROFILE_PATH" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! pgrep -f -- "--user-data-dir=$PROFILE_PATH" >/dev/null \
      && ! curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
mkdir -p /tmp/.X11-unix /run/dbus
dbus-daemon --system --fork 2>/dev/null || true

if [[ "$HEADLESS" != "true" ]]; then
  rm -rf /run/arker-pulse
  install -d -m 777 /run/arker-pulse
  pulseaudio --system --daemonize=yes --disallow-exit --exit-idle-time=-1 -n \
    --log-target=file:/var/log/arker-kernel/pulseaudio.log \
    --load="module-native-protocol-unix socket=/run/arker-pulse/native auth-anonymous=1" \
    --load="module-null-sink sink_name=arker_output rate=48000 channels=2" \
    >/dev/null 2>&1
  for _ in $(seq 1 100); do [[ -S /run/arker-pulse/native ]] && break; sleep 0.05; done
  [[ -S /run/arker-pulse/native ]] || { tail -100 /var/log/arker-kernel/pulseaudio.log >&2 || true; exit 1; }
  nohup Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" -ac +extension GLX +render -noreset \
    >>/var/log/arker-kernel/xvfb.log 2>&1 &
  for _ in $(seq 1 100); do DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && break; sleep 0.05; done
  DISPLAY=:99 nohup openbox >>/var/log/arker-kernel/openbox.log 2>&1 &
  DISPLAY=:99 nohup x11vnc -display :99 -forever -shared -nopw -rfbport 5900 \
    >>/var/log/arker-kernel/x11vnc.log 2>&1 &
  nohup websockify --web=/usr/share/novnc 6080 localhost:5900 \
    >>/var/log/arker-kernel/novnc.log 2>&1 &
fi

if [[ "$HEADLESS" != "true" ]]; then
  DISPLAY=:99 PULSE_SERVER=unix:/run/arker-pulse/native PULSE_SINK=arker_output \
    nohup node "$INSTALL_ROOT/start-browser.mjs" "$CONFIG_PATH" \
    >>/var/log/arker-kernel/browser.log 2>&1 &
else
  DISPLAY=:99 nohup node "$INSTALL_ROOT/start-browser.mjs" "$CONFIG_PATH" \
    >>/var/log/arker-kernel/browser.log 2>&1 &
fi
echo $! >/run/arker-kernel/browser.pid

for _ in $(seq 1 180); do
  if curl -fsS --max-time 2 http://127.0.0.1:9222/json/version \
      | jq -e '.webSocketDebuggerUrl | type == "string"' >/dev/null; then
    if [[ "$HEADLESS" != "true" ]]; then
      python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",5900),1); s.close()' \
        >/dev/null 2>&1 || { sleep 1; continue; }
      curl -fsS --max-time 2 http://127.0.0.1:6080/vnc.html >/dev/null \
        || { sleep 1; continue; }
    fi
    echo cloakbrowser_ready
    "$INSTALL_ROOT/start-playwright-runner.sh"
    echo playwright_runner_ready
    "$INSTALL_ROOT/start-webdriver.sh"
    echo webdriver_bidi_ready
    exit 0
  fi
  if ! kill -0 "$(cat /run/arker-kernel/browser.pid)" 2>/dev/null; then
    tail -100 /var/log/arker-kernel/browser.log >&2 || true
    exit 1
  fi
  sleep 1
done

tail -100 /var/log/arker-kernel/browser.log >&2 || true
echo "CloakBrowser did not expose CDP on port 9222" >&2
exit 1
ARKER_KERNEL_SERVICES

chmod 755 "$INSTALL_ROOT/start-browser.mjs" "$INSTALL_ROOT/playwright-runner.mjs" \
  "$INSTALL_ROOT/start-playwright-runner.sh" "$INSTALL_ROOT/start-webdriver.sh" \
  "$INSTALL_ROOT/start-services.sh"
if [[ -n "$SETUP_FINGERPRINT" ]]; then
  printf '%s' "$SETUP_FINGERPRINT" >"$INSTALL_ROOT/.setup-fingerprint"
  chmod 600 "$INSTALL_ROOT/.setup-fingerprint"
fi
"$INSTALL_ROOT/start-services.sh" "$CONFIG_PATH"
write_prepared_runtime_manifest
