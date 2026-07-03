#!/usr/bin/env bash
#
# Redroid — quick start (a real Android device)
#
# Forks a real Android device (redroid: full Android in an Arker microVM),
# inspects it, installs and launches a real app (NewPipe, from GitHub), and
# pulls back a screenshot.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key

# A real app from GitHub. Any APK works — point APK_URL at your own.
APK_URL="${APK_URL:-https://github.com/TeamNewPipe/NewPipe/releases/download/v0.28.8/NewPipe_v0.28.8.apk}"
APP_PACKAGE="${APP_PACKAGE:-org.schabi.newpipe}"
OUT="${OUT:-redroid-screenshot.png}"

# ── 2. Fork an Android device ───────────────────────────────────────────────
VM=$(arker fork android-small | jq -r .vm_id)
echo "forked android device: $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT
# Run inside the redroid container, retrying a few times (transient 500s happen).
android() { local t; for t in 1 2 3 4 5; do arker run "$VM" "docker exec redroid $1" && return 0; sleep 3; done; return 1; }
vm_run() { local t; for t in 1 2 3 4 5; do arker run "$VM" "$1" && return 0; sleep 3; done; return 1; }

# ── 3. Wait for Android, then show it's a real device ───────────────────────
for i in $(seq 60); do [ "$(android 'getprop sys.boot_completed' 2>/dev/null | tr -d '\r\n ')" = "1" ] && break; sleep 2; done
echo "  $(android 'getprop ro.product.model') · Android $(android 'getprop ro.build.version.release') · $(android 'getprop ro.product.cpu.abi')"

# ── 4. Install and launch the app ───────────────────────────────────────────
vm_run "curl -fsSL -o /root/app.apk '$APK_URL'"
vm_run "docker cp /root/app.apk redroid:/data/local/tmp/app.apk"
android 'pm install -r -t /data/local/tmp/app.apk'
COMP=$(android "cmd package resolve-activity --brief $APP_PACKAGE | tail -1 | tr -d '\r'")
android 'input keyevent KEYCODE_WAKEUP'
android "am start -n $COMP"
sleep 6
android 'input tap 360 760'          # tap the screen
sleep 2

# ── 5. Screenshot → pull it back ────────────────────────────────────────────
android 'screencap -p /data/local/tmp/shot.png'
vm_run "docker cp redroid:/data/local/tmp/shot.png /root/shot.png"
arker sync "$VM" /root/shot.png > "$OUT"
echo "saved $OUT — real Android running $APP_PACKAGE in a microVM"
