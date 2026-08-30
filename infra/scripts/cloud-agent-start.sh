#!/usr/bin/env bash
#
# Per-boot Cloud Agent reconciliation. Does not start servers (terminals do).
# Re-provisions local D1 only when the control-plane companies table is missing.
# Missing optional local files must not fail startup.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_DIR="$REPO_ROOT/infra/packages/api"
INSTALL_SCRIPT="$REPO_ROOT/infra/scripts/cloud-agent-install.sh"

export WRANGLER_SEND_METRICS=false
export CI=1

if [ ! -d "$API_DIR" ]; then
  echo "==> infra API package is not present; nothing to reconcile"
  exit 0
fi

if [ ! -f "$API_DIR/.dev.vars" ] && [ -f "$API_DIR/.dev.vars.example" ]; then
  cp "$API_DIR/.dev.vars.example" "$API_DIR/.dev.vars"
  echo "==> created .dev.vars from .dev.vars.example"
fi

cd "$API_DIR"
if ! npx wrangler d1 execute infra-control-plane --local --command \
  "SELECT id FROM companies WHERE id = 'co_caddington' LIMIT 1;" >/dev/null 2>&1; then
  if [ -f "$INSTALL_SCRIPT" ]; then
    echo "==> Local D1 missing or empty; running install provision"
    bash "$INSTALL_SCRIPT"
  else
    echo "==> Local D1 missing and install script is not present; skipping"
  fi
else
  echo "==> Local D1 already provisioned"
fi
