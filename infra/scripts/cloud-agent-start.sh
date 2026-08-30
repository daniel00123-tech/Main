#!/usr/bin/env bash
#
# Per-boot Cloud Agent reconciliation. Does not start servers (terminals do).
# Re-provisions local D1 only when the control-plane companies table is missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_DIR="$REPO_ROOT/infra/packages/api"

export WRANGLER_SEND_METRICS=false
export CI=1

if [ ! -f "$API_DIR/.dev.vars" ]; then
  cp "$API_DIR/.dev.vars.example" "$API_DIR/.dev.vars"
fi

cd "$API_DIR"
if ! npx wrangler d1 execute infra-control-plane --local --command \
  "SELECT id FROM companies WHERE id = 'co_caddington' LIMIT 1;" >/dev/null 2>&1; then
  echo "==> Local D1 missing or empty; running install provision"
  bash "$REPO_ROOT/infra/scripts/cloud-agent-install.sh"
else
  echo "==> Local D1 already provisioned"
fi
