#!/usr/bin/env bash
#
# Idempotent Cloud Agent / local dev bootstrap for the INFRA monorepo.
#
#   - installs workspace dependencies
#   - creates packages/api/.dev.vars from the example (local placeholder secrets)
#   - provisions the local D1 control-plane database (migrate + seed)
#
# Safe to run repeatedly: dependency install, migrations and seed are all idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
API_DIR="$INFRA_DIR/packages/api"

# wrangler runs fully local (miniflare); keep it non-interactive and offline-friendly.
export WRANGLER_SEND_METRICS=false
export CI=1

echo "==> Installing infra workspace dependencies"
cd "$INFRA_DIR"
# Prefer the lockfile cache. Do not download Caddington production artifacts.
npm install --prefer-offline --no-audit --no-fund

echo "==> Ensuring local dev vars (packages/api/.dev.vars)"
if [ ! -f "$API_DIR/.dev.vars" ]; then
  cp "$API_DIR/.dev.vars.example" "$API_DIR/.dev.vars"
  echo "    created .dev.vars from .dev.vars.example"
else
  echo "    .dev.vars already present, leaving it untouched"
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
  "INSERT OR IGNORE INTO companies (id, slug, name, status, created_at, updated_at) VALUES \
     ('co_caddington','caddington-holdings','Caddington Holdings','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'), \
     ('co_ht','ht-business','HT Business','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'), \
     ('co_el','el-business','EL Business','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');"

npx wrangler d1 migrations apply infra-control-plane --local

echo "==> Seeding local D1 control-plane database"
npm run db:seed:local

echo "==> Install complete"
