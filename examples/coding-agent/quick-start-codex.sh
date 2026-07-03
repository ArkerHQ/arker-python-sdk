#!/usr/bin/env bash
#
# Background coding agent — quick start (Codex)
#
# Forks ubuntu-full and runs the OpenAI Codex CLI inside it. A background coding
# agent is just a VM + a CLI agent.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"    # TODO: set your Arker API key
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-proj-...}"   # TODO: set your OpenAI API key

VM=$(arker fork ubuntu-full | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

arker run "$VM" "npm install -g @openai/codex"
until arker run "$VM" "command -v codex" >/dev/null 2>&1; do sleep 3; done
arker run "$VM" "printf '%s' '$OPENAI_API_KEY' | codex login --with-api-key"
# --dangerously-bypass... skips approvals + Codex's own sandbox (safe: the VM is isolated)
arker run "$VM" "codex exec --dangerously-bypass-approvals-and-sandbox 'create hello.py that prints hello world, then run it'"
