#!/usr/bin/env bash
#
# Android — quick start (a real Android device)
#
# Forks a real Android device (redroid), installs an app from GitHub, launches
# it, and pulls back a screenshot.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
APK_URL="${APK_URL:-https://github.com/TeamNewPipe/NewPipe/releases/download/v0.28.8/NewPipe_v0.28.8.apk}"
APP="${APP:-org.schabi.newpipe}"
OUT="${OUT:-android-screenshot.png}"

VM=$(arker fork android-small | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

# Android runs in a container named redroid; shell commands go through it.
android() { arker run "$VM" "docker exec redroid $*"; }

until [ "$(android getprop sys.boot_completed 2>/dev/null | tr -d '\r\n ')" = 1 ]; do sleep 2; done

arker run "$VM" "curl -fsSL -o /root/app.apk '$APK_URL' && docker cp /root/app.apk redroid:/data/local/tmp/app.apk"
android pm install -r -t /data/local/tmp/app.apk
android input keyevent KEYCODE_WAKEUP
android am start -n "$(android cmd package resolve-activity --brief "$APP" | tail -1 | tr -d '\r')"
sleep 6

android screencap -p /data/local/tmp/shot.png
arker run "$VM" "docker cp redroid:/data/local/tmp/shot.png /root/shot.png"
arker sync "$VM" /root/shot.png > "$OUT"
echo "saved $OUT"
