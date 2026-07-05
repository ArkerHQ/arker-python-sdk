#!/usr/bin/env bash
#
# Background coding agent — quick start (Claude Code)
#
# Forks ubuntu-full and runs the Claude Code CLI inside it. A background coding
# agent is just a VM + a CLI agent.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"        # TODO: set your Arker API key
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-...}"  # TODO: set your Anthropic API key

VM=$(arker fork ubuntu-full | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

# claude-code is already baked into the ubuntu-full golden — fork lands warm, no install.
# IS_SANDBOX=1 + --dangerously-skip-permissions auto-approve tool use (safe: the VM is isolated).
# The agent runs for minutes; a synchronous `arker run` is capped at 300s by the HTTP layer,
# so start it in the background and poll for completion (up to arkerd's 1h exec limit).
RID=$(arker run "$VM" "IS_SANDBOX=1 ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p 'create hello.py that prints hello world, then run it' --dangerously-skip-permissions" --background | jq -r .run_id)
until [ "$(arker runs get "$VM" "$RID" 2>/dev/null | jq -r .state)" != running ]; do sleep 5; done
arker runs get "$VM" "$RID" 2>/dev/null | jq -r '.stdout // ""'
