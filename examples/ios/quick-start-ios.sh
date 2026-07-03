#!/usr/bin/env bash
#
# iOS Simulator — quick start (a real iPhone simulator)
#
# Forks a macOS device, boots an iPhone simulator, opens a native app, and pulls
# back a screenshot.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
export ARKER_REGION="${ARKER_REGION:-us-west-2}"        # macOS hosts live here
OUT="${OUT:-ios-screenshot.png}"
APP="${APP:-com.apple.Preferences}"

VM=$(arker fork macos-full | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT
sim() { arker run "$VM" "$1"; }

until sim 'xcrun simctl help >/dev/null 2>&1'; do sleep 5; done
sim 'D=$(xcrun simctl list devices available | grep -m1 iPhone | grep -oE "[0-9A-F-]{36}"); xcrun simctl boot "$D" 2>/dev/null || true; xcrun simctl bootstatus booted -b'
sim "xcrun simctl launch booted $APP"
# the first app frame takes ~30s to paint on a fresh VM; relaunch, then shoot
sleep 25; sim "xcrun simctl launch booted $APP"; sleep 15
sim 'xcrun simctl io booted screenshot /Users/admin/ios.png'
arker sync "$VM" /Users/admin/ios.png > "$OUT"
echo "saved $OUT"
