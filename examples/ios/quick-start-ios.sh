#!/usr/bin/env bash
#
# iOS Simulator — quick start (a real iPhone simulator)
#
# Forks a macOS device (macos-full, on Apple Tart), boots an iPhone simulator
# inside it, opens a native app (Settings), and pulls back a screenshot of the
# running iOS.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
export ARKER_REGION="${ARKER_REGION:-us-west-2}"        # macOS hosts live here

OUT="${OUT:-ios-screenshot.png}"
APP="${APP:-com.apple.Preferences}"   # native app to open — Settings renders instantly, offline

# ── 2. Fork a macOS device (routes onto a Mac host automatically) ───────────
VM=$(arker fork macos-full | jq -r .vm_id)
echo "forked macOS device: $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT
# Mac VMs are driven over SSH; retry while the guest agent comes up.
sim() { local t; for t in 1 2 3 4 5 6; do arker run "$VM" "$1" && return 0; sleep 5; done; return 1; }

# ── 3. Wait for macOS + Xcode tooling ───────────────────────────────────────
for i in $(seq 60); do sim 'xcrun simctl help >/dev/null 2>&1 && echo ok' 2>/dev/null | grep -q ok && break; sleep 5; done

# ── 4. Boot an iPhone, open a native app, screenshot the device ─────────────
# bootstatus blocks until SpringBoard is up. On a fresh VM the first app frame
# takes ~30s to composite (SpringBoard's status bar paints early, but the app
# layer is black until then), so we launch, wait, relaunch to bring it to the
# front and force a render, wait a little more, and only then screenshot.
sim 'D=$(xcrun simctl list devices available | grep -m1 iPhone | grep -oE "[0-9A-F-]{36}"); xcrun simctl boot "$D" 2>/dev/null || true; xcrun simctl bootstatus booted -b'
sim "xcrun simctl launch booted $APP"
sleep 25
sim "xcrun simctl launch booted $APP"   # relaunch → foreground + force a render
sleep 15                                # let the app (and its icons) finish painting
sim 'xcrun simctl io booted screenshot /Users/admin/ios.png'

# ── 5. Pull the screenshot back ─────────────────────────────────────────────
arker sync "$VM" /Users/admin/ios.png > "$OUT"
echo "saved $OUT — a real iPhone simulator running iOS in a macOS VM"
