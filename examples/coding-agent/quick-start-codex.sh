#!/usr/bin/env bash
#
# Background coding agent — quick start (Codex)
#
# Forks ubuntu-dev and runs the OpenAI Codex CLI inside it. A background coding
# agent is just a VM + a CLI agent.
#
# Prereqs: the Arker CLI (`bun add --global @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"    # TODO: set your Arker API key
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-proj-...}"   # TODO: set your OpenAI API key

VM=$(arker fork ubuntu-dev | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

# codex is already baked into the ubuntu-dev golden — fork lands warm, no install.
arker run "$VM" "printf '%s' '$OPENAI_API_KEY' | codex login --with-api-key"
# --dangerously-bypass... skips approvals + Codex's own sandbox (safe: the VM is isolated).
# The agent runs for minutes; a synchronous `arker run` is capped at 300s by the HTTP layer,
# so start it in the background and poll for completion (up to arkerd's 1h exec limit).
RID=$(arker run "$VM" "codex exec --dangerously-bypass-approvals-and-sandbox 'create hello.py that prints hello world, then run it'" --background | jq -r .run_id)
until [ "$(arker runs get "$VM" "$RID" 2>/dev/null | jq -r .state)" != running ]; do sleep 5; done
arker runs get "$VM" "$RID" 2>/dev/null | jq -r '.stdout // ""'
