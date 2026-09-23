#!/usr/bin/env bash
#
# Idempotent Cloud Agent / local-dev bootstrap.
#
#   - installs infra workspace dependencies
#   - installs the root monorepo when present (feature branches with workers/)
#   - copies local placeholder .dev.vars from the example when missing
#   - provisions the local D1 control-plane database (migrate + seed)
#
# Safe to run repeatedly. Missing optional local files must not fail setup.
# Does not touch production Workers, D1, secrets, or connector credentials.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
API_DIR="$INFRA_DIR/packages/api"

export WRANGLER_SEND_METRICS=false
export CI=1

ensure_dev_vars() {
  if [ -f "$API_DIR/.dev.vars" ]; then
    echo "    .dev.vars already present, leaving it untouched"
    return 0
  fi
  if [ -f "$API_DIR/.dev.vars.example" ]; then
    cp "$API_DIR/.dev.vars.example" "$API_DIR/.dev.vars"
    echo "    created .dev.vars from .dev.vars.example"
    return 0
  fi
  echo "    skipping .dev.vars (optional example file is not present)"
}

if [ -f "$REPO_ROOT/package.json" ] && [ -d "$REPO_ROOT/workers" ]; then
  echo "==> Installing root workspace dependencies"
  (
    cd "$REPO_ROOT"
    npm install --prefer-offline --no-audit --no-fund
  )
fi

if [ ! -d "$INFRA_DIR" ] || [ ! -f "$INFRA_DIR/package.json" ]; then
  echo "==> infra workspace is not present; skipping INFRA bootstrap"
  echo "==> Install complete"
  exit 0
fi

echo "==> Installing infra workspace dependencies"
cd "$INFRA_DIR"
npm install --prefer-offline --no-audit --no-fund

echo "==> Ensuring local dev vars (packages/api/.dev.vars)"
ensure_dev_vars

if [ ! -d "$API_DIR" ]; then
  echo "==> infra API package is not present; skipping local D1"
  echo "==> Install complete"
  exit 0
fi

echo "==> Provisioning local D1 control-plane database"
cd "$API_DIR"

# Migrations 0008/0033 seed rows for the base tenants (co_caddington/co_ht/co_el)
# through foreign keys, but those companies are only created by src/seed.sql, which
# runs after migrations. On a brand-new local database the first apply therefore
# stops at 0008 with a FOREIGN KEY error. Apply everything we can, guarantee the
# referenced tenants exist, then finish the remaining migrations.
npx wrangler d1 migrations apply infra-control-plane --local || true

npx wrangler d1 execute infra-control-plane --local --command \
  "INSERT OR IGNORE INTO companies (id, slug, name, status, created_at, updated_at) VALUES
     ('co_caddington','caddington-holdings','Caddington Holdings','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
     ('co_ht','ht-business','HT Business','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
     ('co_el','el-business','EL Business','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');" \
  || echo "    warning: local tenant insert skipped (database not ready)"

npx wrangler d1 migrations apply infra-control-plane --local \
  || echo "    warning: remaining local D1 migrations skipped"

if [ -f "$API_DIR/src/seed.sql" ]; then
  echo "==> Seeding local D1 control-plane database"
  npm run db:seed:local || echo "    warning: local D1 seed skipped"
else
  echo "==> Skipping local D1 seed (optional src/seed.sql is not present)"
fi

echo "==> Install complete"
