#!/usr/bin/env bash
#
# Background coding agent — quick start (Codex)
#
# Forks a caller-selected source and runs the OpenAI Codex CLI inside it.
#
# Prereqs: the Arker CLI (`bun add --global @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"    # TODO: set your Arker API key
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-proj-...}"   # TODO: set your OpenAI API key
: "${ARKER_SOURCE_VM:?set ARKER_SOURCE_VM to a source that contains Codex}"

VM=$(arker fork "$ARKER_SOURCE_VM" | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

# The selected source contains Codex, so no install is necessary.
arker run "$VM" "printf '%s' '$OPENAI_API_KEY' | codex login --with-api-key"
# --dangerously-bypass... skips approvals + Codex's own sandbox (safe: the VM is isolated).
# The agent runs for minutes, so start it in the background and poll for completion.
RID=$(arker run "$VM" "codex exec --dangerously-bypass-approvals-and-sandbox 'create hello.py that prints hello world, then run it'" --background | jq -r .run_id)
until [ "$(arker runs get "$VM" "$RID" 2>/dev/null | jq -r .state)" != running ]; do sleep 5; done
arker runs get "$VM" "$RID" 2>/dev/null | jq -r '.stdout // ""'
