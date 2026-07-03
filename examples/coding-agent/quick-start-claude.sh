#!/usr/bin/env bash
#
# Background coding agent — quick start (Claude Code)
#
# Forks a fresh machine from the public `ubuntu-full` golden and runs the Claude
# Code CLI agent inside it to make a small code change. A background coding agent
# is just a VM + a CLI agent, so this is the whole pattern in ~3 commands.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="ark_live_..."        # TODO: set your Arker API key
# Claude Code uses an Anthropic key for the agent (https://console.anthropic.com).
export ANTHROPIC_API_KEY="sk-ant-..."       # TODO: set your Anthropic API key

# ── 2. Fork a machine ───────────────────────────────────────────────────────
# `ubuntu-full` is a public golden (Node.js + Python preinstalled).
VM=$(arker fork ubuntu-full | jq -r .vm_id)
echo "forked machine: $VM"

# ── 3. Run the Claude Code agent inside the machine ─────────────────────────
# Install Claude Code, then have it carry out a basic task.
arker run "$VM" "npm install -g @anthropic-ai/claude-code"
# A long install returns as soon as it goes async, so wait for the CLI to appear.
for _ in $(seq 40); do arker run "$VM" "command -v claude" >/dev/null 2>&1 && break; sleep 3; done
# `-p` is the non-interactive (print) mode; `--dangerously-skip-permissions`
# auto-approves tool use. The golden runs as root, so `IS_SANDBOX=1` tells Claude
# Code it's safe to skip permissions there — true, since the VM is isolated.
arker run "$VM" "IS_SANDBOX=1 ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p 'create hello.py that prints hello world, then run it' --dangerously-skip-permissions"

# ── 4. Clean up ─────────────────────────────────────────────────────────────
arker rm "$VM"
