#!/usr/bin/env bash
#
# Android app — quick start (redroid)
#
# Forks a real Android device (redroid: full Android in an Arker microVM),
# installs an app, drives it, and pulls back a screenshot.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key

# The app to install and drive — any APK works; point APK_URL at your own.
APK_URL="${APK_URL:-https://f-droid.org/F-Droid.apk}"
APP_PACKAGE="${APP_PACKAGE:-org.fdroid.fdroid}"
OUT="${OUT:-android-screenshot.png}"

# ── 2. Fork an Android device ───────────────────────────────────────────────
VM=$(arker fork android-small | jq -r .vm_id)
echo "forked android device: $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT
android() { arker run "$VM" "docker exec redroid $*"; }   # run inside the container

# ── 3. Wait for Android, then install the app ───────────────────────────────
for i in $(seq 30); do [ "$(android getprop sys.boot_completed | tr -d '\r\n ')" = "1" ] && break; sleep 2; done
arker run "$VM" "curl -fsSL -o /root/app.apk '$APK_URL'"
arker run "$VM" "docker cp /root/app.apk redroid:/data/local/tmp/app.apk"
android pm install -r -t /data/local/tmp/app.apk | tail -1

# ── 4. Launch it and use it (open search, type a query) ─────────────────────
android am start -n "$(android "cmd package resolve-activity --brief $APP_PACKAGE | tail -1 | tr -d '\r'")"
sleep 5
android input tap 660 140            # search icon — coords are for 720x1280; tune per app
sleep 1
android input text firefox
android input keyevent KEYCODE_ENTER
sleep 3

# ── 5. Screenshot → pull it back ────────────────────────────────────────────
android screencap -p /data/local/tmp/shot.png
arker run "$VM" "docker cp redroid:/data/local/tmp/shot.png /root/shot.png"
arker sync "$VM" /root/shot.png > "$OUT"
echo "saved $OUT"
