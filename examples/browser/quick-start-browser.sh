#!/usr/bin/env bash
#
# Browser checkpoints — quick start (fork a running browser, reopen it live)
#
# `fork` on Arker snapshots a machine's live MEMORY *and* disk. So forking a
# running browser checkpoints it mid-session: the fork RESUMES the exact
# Chromium process — same JS heap, same page — it does not cold-start.
#
# This forks the public `ubuntu-desktop-vnc` golden (a real X desktop + noVNC +
# a small control server), installs Chromium once, then does
#   fork → interact → fork → interact
# and leaves you two checkpoints you can reopen in your browser:
#   A · a live in-memory counter      B · deep inside a real website
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`), `jq`, and `curl`.

set -euo pipefail

# ── 1. Credentials + config ─────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
REGION="${ARKER_REGION:-us-west-2}"
BASE="${ARKER_BASE_URL:-https://aws-${REGION}.arker.ai/api}"

# ── 2. Fork the desktop golden and install Chromium → the "browser base" ────
# ubuntu-desktop-vnc is a real desktop (Xvnc on :99, openbox, noVNC) but ships
# no browser. We add Chromium from the xtradeb PPA — the hosts are arm64
# (Graviton) and Google ships no aarch64 Chrome. This IS the "make your own
# golden" step: install what you want into a VM, then fork that VM.
VM=$(arker fork ubuntu-desktop-vnc | jq -r .vm_id)
echo "forked browser base: $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT   # base torn down; checkpoints kept (see end)

arker run --timeout 480 "$VM" "export DEBIAN_FRONTEND=noninteractive; \
  apt-get install -y -qq software-properties-common && \
  add-apt-repository -y ppa:xtradeb/apps && apt-get update -qq && \
  apt-get install -y -qq chromium" >/dev/null 2>&1 || true
# The install may run in the background; wait until Chromium is really there.
for _ in $(seq 60); do
  arker run "$VM" "command -v chromium >/dev/null && echo READY" 2>/dev/null | grep -q READY && break
  sleep 5
done
echo "installed $(arker run "$VM" 'chromium --version' 2>/dev/null)"

# ── 3. Upload a tiny desktop driver (avoids fragile inline xdotool quoting) ──
# `desk browse <url>` launches Chromium fullscreen on :99 and raises it above
# the desktop's terminal; `desk shot <path>` grabs the VNC framebuffer to a PNG.
arker sync "$VM" /usr/local/bin/desk <<'DESK'
#!/usr/bin/env bash
set -e; export DISPLAY=:99 HOME=/root
raise(){ local w; w=$(xdotool search --class chromium 2>/dev/null | tail -1); [ -n "$w" ] && { xdotool windowactivate --sync "$w"; xdotool windowraise "$w"; } || true; }
case "$1" in
  browse) pkill -f chromium 2>/dev/null || true; sleep 1
    nohup chromium --kiosk --no-sandbox --no-first-run --no-default-browser-check \
      --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/cprof "$2" >/tmp/chrome.log 2>&1 &
    for _ in $(seq 40); do xdotool search --class chromium >/dev/null 2>&1 && break; sleep 0.5; done
    sleep 3; raise ;;
  shot)   raise; sleep 1; scrot -o "$2" ;;
  *)      echo "usage: desk browse <url> | shot <path>" >&2; exit 1 ;;
esac
DESK
arker run "$VM" "chmod +x /usr/local/bin/desk" >/dev/null

# A page whose state lives ONLY in memory: a counter ticking in Chromium's JS heap.
arker sync "$VM" /root/counter.html <<'HTML'
<!doctype html><meta charset=utf-8><style>
html,body{margin:0;height:100%;background:#0b1020;color:#7fee64;font-family:monospace;overflow:hidden}
.w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}
#n{font-size:34vw;font-weight:800}#l{font-size:3vw;color:#5bd4ff}</style>
<div class=w><div id=l>LIVE COUNTER (Chromium JS heap)</div><div id=n>0</div></div>
<script>var n=0;setInterval(function(){n++;document.getElementById('n').textContent=n},100)</script>
HTML

# ── 4. fork · run · fork · run  → two checkpoints of one session ─────────────
# run: open the counter and let it climb (this number lives only in memory).
arker run "$VM" "desk browse file:///root/counter.html" >/dev/null
sleep 8
# fork: checkpoint A captures the running browser, counter mid-tick.
CKPT_A=$(arker fork --source-vm-id "$VM" | jq -r .vm_id)
echo "checkpoint A (in-memory counter): $CKPT_A"

# run: keep browsing the SAME session, deep into a real site.
arker run "$VM" "desk browse https://en.wikipedia.org/wiki/Virtual_machine" >/dev/null
sleep 8
# fork: checkpoint B captures that page.
CKPT_B=$(arker fork --source-vm-id "$VM" | jq -r .vm_id)
echo "checkpoint B (deep in a website): $CKPT_B"

# ── 5. Reopen each checkpoint and screenshot what it was doing ───────────────
# Each fork resumes from memory (X already up, same Chromium window), so the
# screenshot shows the exact moment it was checkpointed.
for pair in "a:$CKPT_A" "b:$CKPT_B"; do
  label=${pair%%:*}; ck=${pair#*:}
  arker run "$ck" "desk shot /root/shot.png" >/dev/null
  arker sync "$ck" /root/shot.png > "checkpoint-$label.png"
  echo "saved checkpoint-$label.png"
done

# ── 6. Make checkpoint A reachable → open it live in your browser (noVNC) ────
# Inbound reachability isn't exposed on the CLI, so PATCH the API directly.
HOST=$(curl -fsS -X PATCH "$BASE/v1/vms/$CKPT_A" \
  -H "authorization: Bearer $ARKER_API_KEY" -H 'content-type: application/json' \
  -d '{"network":{"reachable":true}}' | jq -r '.network.hostname // empty')
[ -n "$HOST" ] && echo "live preview: https://$HOST:6080/vnc.html  (accept the cert, then click Connect)"

# ── 7. Checkpoints are left running so you can reopen them ───────────────────
# The base VM is torn down on exit (trap above). Remove the checkpoints when done:
echo "when finished:  arker rm $CKPT_A $CKPT_B"
