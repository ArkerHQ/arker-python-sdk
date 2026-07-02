#!/usr/bin/env bash
#
# Redroid — quick start (a real Android device)
#
# Forks a real Android device (redroid: full Android in an Arker microVM),
# inspects it, installs and drives an app, and pulls back a screenshot.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key

# A real, offline app so the screenshot always shows something. Any APK works.
APK_URL="${APK_URL:-https://github.com/FossifyOrg/Calculator/releases/download/1.4.0/calculator-10-foss-release.apk}"
APP_PACKAGE="${APP_PACKAGE:-org.fossify.calculator}"
OUT="${OUT:-redroid-screenshot.png}"

# ── 2. Fork an Android device ───────────────────────────────────────────────
VM=$(arker fork android-small | jq -r .vm_id)
echo "forked android device: $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT
android() { arker run "$VM" "docker exec redroid $*"; }

# ── 3. Wait for Android, then show it's a real device ───────────────────────
for i in $(seq 30); do [ "$(android getprop sys.boot_completed | tr -d '\r\n ')" = "1" ] && break; sleep 2; done
echo "  $(android getprop ro.product.model) · Android $(android getprop ro.build.version.release) · $(android getprop ro.product.cpu.abi)"

# ── 4. Install, launch, and use an app ──────────────────────────────────────
arker run "$VM" "curl -fsSL -o /root/app.apk '$APK_URL'"
arker run "$VM" "docker cp /root/app.apk redroid:/data/local/tmp/app.apk"
android pm install -r -t /data/local/tmp/app.apk | tail -1
android am start -n "$(android "cmd package resolve-activity --brief $APP_PACKAGE | tail -1 | tr -d '\r'")"
sleep 4
android input keyevent KEYCODE_7 KEYCODE_PLUS KEYCODE_8 KEYCODE_EQUALS   # compute 7 + 8
sleep 2

# ── 5. Screenshot → pull it back ────────────────────────────────────────────
android screencap -p /data/local/tmp/shot.png
arker run "$VM" "docker cp redroid:/data/local/tmp/shot.png /root/shot.png"
arker sync "$VM" /root/shot.png > "$OUT"
echo "saved $OUT — real Android, running $APP_PACKAGE in a microVM"
