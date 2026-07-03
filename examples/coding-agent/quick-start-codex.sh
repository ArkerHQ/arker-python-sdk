#!/usr/bin/env bash
#
# Background coding agent — quick start (Codex)
#
# Forks a fresh machine from the public `ubuntu-full` golden and runs the OpenAI
# Codex CLI agent inside it to make a small code change. A background coding
# agent is just a VM + a CLI agent, so this is the whole pattern in ~4 commands.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="ark_live_..."        # TODO: set your Arker API key
# Codex uses an OpenAI key for the agent (https://platform.openai.com/api-keys).
export OPENAI_API_KEY="sk-proj-..."         # TODO: set your OpenAI API key

# ── 2. Fork a machine ───────────────────────────────────────────────────────
# `ubuntu-full` is a public golden (Node.js + Python preinstalled).
VM=$(arker fork ubuntu-full | jq -r .vm_id)
echo "forked machine: $VM"

# ── 3. Install + authenticate the Codex CLI inside the machine ──────────────
arker run "$VM" "npm install -g @openai/codex"
# A long install returns as soon as it goes async, so wait for the CLI to appear.
for _ in $(seq 40); do arker run "$VM" "command -v codex" >/dev/null 2>&1 && break; sleep 3; done
# Codex reads the key from stdin and stores it in ~/.codex/auth.json, so later
# `codex exec` calls are already authenticated.
arker run "$VM" "printf '%s' '$OPENAI_API_KEY' | codex login --with-api-key"

# ── 4. Run the Codex agent on a task ────────────────────────────────────────
# `codex exec` is the non-interactive mode. `--dangerously-bypass-approvals-and-
# sandbox` skips the approval prompts and Codex's own sandbox — safe here because
# the VM is already an isolated sandbox.
arker run "$VM" "codex exec --dangerously-bypass-approvals-and-sandbox 'create hello.py that prints hello world, then run it'"

# ── 5. Clean up ─────────────────────────────────────────────────────────────
arker rm "$VM"
