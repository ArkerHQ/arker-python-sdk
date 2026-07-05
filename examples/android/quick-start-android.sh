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
export ARKER_REGION="${ARKER_REGION:-us-west-2}"        # redroid Android hosts live here
APK_URL="${APK_URL:-https://github.com/FossifyOrg/Calculator/releases/download/1.4.0/calculator-10-foss-release.apk}"
APP="${APP:-org.fossify.math}"
OUT="${OUT:-android-screenshot.png}"

VM=$(arker fork android-small | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

# Android runs in a container named redroid; shell commands go through it.
# `{ set +x; } 2>/dev/null` silences the guest session shell's command trace.
android() { arker run "$VM" "{ set +x; } 2>/dev/null; docker exec redroid $*"; }

# the golden is pre-booted, so this returns immediately
until [ "$(android getprop sys.boot_completed | tr -d '\r\n ')" = 1 ]; do sleep 2; done

# download the APK (host side) and copy it into the device.
# `-g` grants runtime permissions at install so no system permission dialog blocks the UI.
arker run "$VM" "{ set +x; } 2>/dev/null; curl -fsSL -o /root/app.apk '$APK_URL' && docker cp /root/app.apk redroid:/data/local/tmp/app.apk"
android pm install -r -t -g /data/local/tmp/app.apk

# launch the app's LAUNCHER activity
android input keyevent KEYCODE_WAKEUP
ACT=$(android cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "$APP" | tail -1 | tr -d '\r')
android am start -n "$ACT"

# wait until the app is the foreground (resumed) activity, then give redroid's
# software renderer time to paint the first content frame past the launch splash
for _ in $(seq 1 30); do
  if android dumpsys activity activities | grep -m1 -i ResumedActivity | grep -qi "$APP"; then break; fi
  sleep 2
done
sleep 30

android screencap -p /data/local/tmp/shot.png
arker run "$VM" "{ set +x; } 2>/dev/null; docker cp redroid:/data/local/tmp/shot.png /root/shot.png"
arker sync "$VM" /root/shot.png > "$OUT"
echo "saved $OUT"
