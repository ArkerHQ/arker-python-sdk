#!/usr/bin/env bash
#
# Policies as code — quick start (host-enforced network policy)
#
# Forks a machine from the public `ubuntu-full` golden and attaches a network
# policy DOCUMENT: an ordered, first-match-wins list of `outbound` rules
# that allow / deny / rewrite / gate each request, enforced in the host network path (a
# process in the VM can't flush iptables to escape it). The CLI has no policy
# verb, so we PUT the document to the API; everything else is `arker fork`/`run`.
#
# Prereqs: the Arker CLI (`npm install -g @arker-ai/sdk`), `jq`, and `curl`.

set -euo pipefail

# ── 1. Credentials ──────────────────────────────────────────────────────────
# Get an Arker key at https://arker.ai/console
export ARKER_API_KEY="${ARKER_API_KEY:-ark_live_...}"   # TODO: set your Arker API key

# ── Config ──────────────────────────────────────────────────────────────────
REGION="${ARKER_REGION:-us-west-2}"
BASE="${ARKER_BASE_URL:-https://aws-${REGION}.arker.ai/api}"   # region API endpoint
GOLDEN="${ARKER_GOLDEN:-ubuntu-full}"

# ── 2. Fork a machine ───────────────────────────────────────────────────────
VM=$(arker fork "$GOLDEN" | jq -r .vm_id)
echo "forked machine: $VM"
cleanup() { arker rm "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ── 3. Attach the policy document (PUT /v1/vms/{id}/policies) ────────────────
#   1. rewrite httpbin.org: inject x-api-key and strip the guest's own
#      authorization header
#   2. deny openai.com
#   3. allow everything else
# The injected credential is stored in the policy on the HOST (encrypted at rest,
# redacted on GET) and merged in as the request leaves; the guest never sees it.
curl -fsS -X PUT "$BASE/v1/vms/$VM/policies" \
  -H "authorization: Bearer $ARKER_API_KEY" -H 'content-type: application/json' \
  -d '{
    "policies": [
      {"type":"outbound","match":{"hosts":["httpbin.org"]},
       "action":{"rewrite":{"headers":{"x-api-key":"sk-demo-the-guest-never-sees-this"},"remove_headers":["authorization"]}}},
      {"type":"outbound","match":{"hosts":["openai.com"]},"action":"deny"},
      {"type":"outbound","action":"allow"}
    ]
  }' >/dev/null
echo "attached policy (rewrite httpbin · deny openai · allow *)"

# ── 4. Prove each rule from inside the VM ───────────────────────────────────
# 1. rewrite + secret: httpbin.org/headers echoes what the UPSTREAM server saw.
echo "  rewrite httpbin.org (expect x-api-key = the secret, no authorization):"
arker run "$VM" "curl -s -H 'authorization: Bearer guest-token' https://httpbin.org/headers" \
  | grep -iE '"x-api-key"|"authorization"' || echo "    (no matching headers echoed)"
# 2. deny: openai.com must be refused (no HTTP status returned).
CODE=$(arker run "$VM" "curl -s -m 8 -o /dev/null -w '%{http_code}' https://openai.com/ || true")
if [ -z "$CODE" ] || [ "$CODE" = "000" ]; then echo "  deny openai.com    : BLOCKED"; else echo "  deny openai.com    : REACHED code=$CODE"; fi
# 3. allow catch-all: example.com works.
CODE=$(arker run "$VM" "curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com/ || true")
echo "  allow example.com  : code=$CODE"

# Cleanup runs on exit (trap above).
