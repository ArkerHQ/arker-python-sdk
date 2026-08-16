#!/usr/bin/env bash
#
# Policies as code — quick start (egress policy)
#
# Forks a caller-selected source and attaches an ordered list of outbound
# rules (allow / deny / rewrite / gate), enforced outside the VM so no process
# inside it can bypass them. The CLI has no policy verb, so we PUT the
# document to the API.
#
# Prereqs: the Arker CLI (`bun add --global @arker-ai/sdk`), `jq`, and `curl`.

set -euo pipefail

export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key
: "${ARKER_SOURCE_VM:?set ARKER_SOURCE_VM to a source name}"
REGION="${ARKER_REGION:-us-west-2}"
BASE="https://aws-${REGION}.arker.ai/api"

VM=$(arker fork "$ARKER_SOURCE_VM" | jq -r .vm_id)
echo "forked $VM"
trap 'arker rm "$VM" >/dev/null 2>&1 || true' EXIT

# rewrite httpbin.org (inject a secret, strip the VM's authorization) · deny
# openai.com · allow the rest. The injected credential is stored by Arker
# (encrypted, redacted on read); the VM never sees it.
curl -fsS -X PUT "$BASE/v1/vms/$VM/policies" \
  -H "authorization: Bearer $ARKER_API_KEY" -H 'content-type: application/json' \
  -d '{
    "policies": [
      {"type":"outbound","match":{"hosts":["httpbin.org"]},
       "action":{"rewrite":{"headers":{"x-api-key":"sk-demo-the-vm-never-sees-this"},"remove_headers":["authorization"]}}},
      {"type":"outbound","match":{"hosts":["openai.com"]},"action":"deny"},
      {"type":"outbound","action":"allow"}
    ]
  }' >/dev/null
echo "attached policy (rewrite httpbin · deny openai · allow *)"

echo "  rewrite httpbin.org (expect x-api-key = the secret, no authorization):"
arker run "$VM" "curl -s -H 'authorization: Bearer vm-token' https://httpbin.org/headers" \
  | grep -iE '"x-api-key"|"authorization"' || echo "    (none)"
CODE=$(arker run "$VM" "curl -s -m 8 -o /dev/null -w '%{http_code}' https://openai.com/ || true")
if [ -z "$CODE" ] || [ "$CODE" = "000" ]; then echo "  deny openai.com    : BLOCKED"; else echo "  deny openai.com    : REACHED $CODE"; fi
echo "  allow example.com  : $(arker run "$VM" "curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com/ || true")"
