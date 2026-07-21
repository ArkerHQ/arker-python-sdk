#!/usr/bin/env bash
#
# Background coding agent — quick start (Cursor)
#
# Forks ubuntu-full and runs the Cursor CLI inside it. A background coding agent
# is just a VM + a CLI agent.
#
# Prereqs: the Arker CLI (`bun add --global @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
export CURSOR_API_KEY="${CURSOR_API_KEY:-...}"          # TODO: set your Cursor API key

VM=$(arker fork ubuntu-full | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

# cursor-agent is already baked into the ubuntu-full golden — fork lands warm, no install.
# -f trusts the workspace (required non-interactively).
# The agent runs for minutes; a synchronous `arker run` is capped at 300s by the HTTP layer,
# so start it in the background and poll for completion (up to arkerd's 1h exec limit).
RID=$(arker run "$VM" "CURSOR_API_KEY=$CURSOR_API_KEY cursor-agent -f -p 'create hello.py that prints hello world, then run it'" --background | jq -r .run_id)
until [ "$(arker runs get "$VM" "$RID" 2>/dev/null | jq -r .state)" != running ]; do sleep 5; done
arker runs get "$VM" "$RID" 2>/dev/null | jq -r '.stdout // ""'
