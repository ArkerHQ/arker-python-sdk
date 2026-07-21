#!/usr/bin/env bash
#
# Browser checkpoints — quick start
#
# fork snapshots a machine's live memory, so forking a running browser
# checkpoints it mid-session. Here we open two Wikipedia pages and fork at each,
# leaving two live checkpoints you can reopen over VNC.
#
# Prereqs: the Arker CLI (`bun add --global @arker-ai/sdk`), `jq`, and `curl`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
REGION="${ARKER_REGION:-us-west-2}"
BASE="https://aws-${REGION}.arker.ai/api"

# ubuntu-desktop-vnc ships the desktop but no browser; add Chromium (arm64 build
# from the xtradeb PPA).
VM=$(arker fork ubuntu-desktop-vnc | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT
arker run --timeout 480 "$VM" "export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq software-properties-common && add-apt-repository -y ppa:xtradeb/apps && apt-get update -qq && apt-get install -y -qq chromium" >/dev/null 2>&1 || true
until arker run "$VM" "command -v chromium" >/dev/null 2>&1; do sleep 5; done

# open <url> fullscreen on the VNC desktop (display :99)
arker sync "$VM" /usr/local/bin/open-url <<'SH'
#!/usr/bin/env bash
export DISPLAY=:99 HOME=/root
pkill -f chromium 2>/dev/null; sleep 1
nohup chromium --kiosk --no-sandbox --no-first-run --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/c "$1" >/dev/null 2>&1 &
until xdotool search --class chromium >/dev/null 2>&1; do sleep 0.5; done
sleep 3; wid=$(xdotool search --class chromium | tail -1); xdotool windowactivate --sync "$wid"; xdotool windowraise "$wid"
SH
arker run "$VM" "chmod +x /usr/local/bin/open-url" >/dev/null

# open a page, fork a checkpoint, make it reachable, print its noVNC URL
checkpoint() {
  arker run "$VM" "open-url '$1'" >/dev/null
  sleep 4
  local ck host
  ck=$(arker fork --source-vm-id "$VM" | jq -r .vm_id)
  host=$(curl -fsS -X PATCH "$BASE/v1/vms/$ck" -H "authorization: Bearer $ARKER_API_KEY" \
    -H 'content-type: application/json' -d '{"network":{"reachable":true}}' | jq -r .network.hostname)
  echo "$2: https://$host:6080/vnc.html"
}
checkpoint "https://en.wikipedia.org/wiki/Virtual_machine" "checkpoint A"
checkpoint "https://en.wikipedia.org/wiki/Firecracker_(software)" "checkpoint B"
