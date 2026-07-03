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

arker run "$VM" "npm install -g @anthropic-ai/claude-code"
until arker run "$VM" "command -v claude" >/dev/null 2>&1; do sleep 3; done
# IS_SANDBOX=1 + --dangerously-skip-permissions auto-approve tool use (safe: the VM is isolated)
arker run "$VM" "IS_SANDBOX=1 ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p 'create hello.py that prints hello world, then run it' --dangerously-skip-permissions"
