#!/usr/bin/env bash
# Refuse to deploy an OAuth-only or WhatsApp-only infra-api over production.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
API="$ROOT/packages/api"
fail=0

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "REFUSE DEPLOY: missing $1"
    fail=1
  fi
}

require_file "$API/src/routes/whatsapp.ts"
require_file "$API/src/routes/oauth.ts"
require_file "$ROOT/migrations/0049_mcp_user_oauth.sql"

if ! rg -q 'whatsappRoutes' "$API/src/index.ts"; then
  echo "REFUSE DEPLOY: WhatsApp routes are not mounted"
  fail=1
fi
if ! rg -q 'oauthRoutes' "$API/src/index.ts"; then
  echo "REFUSE DEPLOY: OAuth routes are not mounted"
  fail=1
fi
if ! rg -q 'WHATSAPP_INBOUND_QUEUE' "$API/wrangler.toml"; then
  echo "REFUSE DEPLOY: WhatsApp inbound queue binding missing from wrangler.toml"
  fail=1
fi
if ! rg -q 'INFRA_API_LINEAGE = "whatsapp-v5\+oauth-398"' "$API/wrangler.toml"; then
  echo "REFUSE DEPLOY: wrangler.toml is not the combined WhatsApp+OAuth lineage"
  fail=1
fi
if rg -q 'INFRA_PUBLIC_API_URL = "https://infra-api.daniel-dwyer123.workers.dev"' "$API/wrangler.toml"; then
  echo "REFUSE DEPLOY: wrangler.toml looks like the OAuth-only mainline, not production WhatsApp"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "This tree is not the combined production infra-api. Deploy aborted."
  exit 1
fi
echo "Combined infra-api guard passed (WhatsApp V5 + INFRA OAuth #398)."
