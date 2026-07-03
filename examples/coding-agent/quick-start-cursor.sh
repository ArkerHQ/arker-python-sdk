#!/usr/bin/env bash
#
# Background coding agent — quick start (Cursor)
#
# Forks ubuntu-full and runs the Cursor CLI inside it. A background coding agent
# is just a VM + a CLI agent.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`) and `jq`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
export CURSOR_API_KEY="${CURSOR_API_KEY:-...}"          # TODO: set your Cursor API key

VM=$(arker fork ubuntu-full | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

arker run "$VM" "curl https://cursor.com/install -fsS | bash"
until arker run "$VM" "command -v cursor-agent" >/dev/null 2>&1; do sleep 3; done
# -f trusts the workspace (required non-interactively)
arker run "$VM" "CURSOR_API_KEY=$CURSOR_API_KEY cursor-agent -f -p 'create hello.py that prints hello world, then run it'"
