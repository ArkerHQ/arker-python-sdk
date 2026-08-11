#!/usr/bin/env bash
#
# Background coding agent — quick start
#
# Forks a fresh machine from the public `ubuntu-full` golden and runs the Cursor
# CLI agent inside it to make a small code change. A background coding agent is
# just a VM + a CLI agent, so this is the whole pattern in ~3 commands.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail
export ARKER_REGION="us-west-2"

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="ark_live_vl6P0Bq9FL2HVUGLsWIzumuFbD90AT2g"        # TODO: set your Arker API key
# Cursor uses its own key for the agent (https://cursor.com/dashboard).
export CURSOR_API_KEY="crsr_9144a9706761870c543d4c16bf69b77f85b6cb51cc05c37d5330f8b5114a035e"                 # TODO: set your Cursor API key

# ── 2. Fork a machine ───────────────────────────────────────────────────────
# `ubuntu-full` is a public golden (Node.js + Python preinstalled).
VM=$(arker fork ubuntu-full | jq -r .vm_id)
echo "forked machine: $VM"

# ── 3. Run the Cursor CLI agent inside the machine ──────────────────────────
# Install the Cursor CLI, then have it carry out a basic task.
arker run "$VM" "curl https://cursor.com/install -fsS | bash"
# `-f` (trust this directory) is required for non-interactive use; without it
# cursor-agent stops on a "Workspace Trust Required" prompt and never runs.
arker run "$VM" "CURSOR_API_KEY=$CURSOR_API_KEY cursor-agent -f -p 'create hello.py that prints hello world, then run it'"

# ── 4. Clean up ─────────────────────────────────────────────────────────────
arker rm "$VM"
