#!/usr/bin/env node
/**
 * Align Caddington auto top-up threshold to £25 standard without enabling execution.
 * Safe when wallet balance is above the new threshold.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPANY_ID = "co_caddington";
const TARGET_THRESHOLD_CENTS = 2500;
const TARGET_AMOUNT_CENTS = 2500;
const dryRun = process.argv.includes("--dry-run");

function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1Exec(sql) {
  if (dryRun) return;
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql],
    { cwd: apiDir, encoding: "utf8", stdio: "pipe" },
  );
}

const wallet = d1Query(
  `SELECT balance_cents FROM credit_balances WHERE company_id = '${COMPANY_ID}'`,
)[0];
const settings = d1Query(
  `SELECT auto_top_up_enabled, auto_top_up_threshold_cents, auto_top_up_amount_cents
   FROM company_commercial_settings WHERE company_id = '${COMPANY_ID}'`,
)[0];

const balanceCents = Number(wallet?.balance_cents ?? 0);
const safeToLowerThreshold = balanceCents > TARGET_THRESHOLD_CENTS;

if (!safeToLowerThreshold) {
  console.log(
    JSON.stringify(
      {
        updated: false,
        reason: "balance_at_or_below_new_threshold",
        balanceCents,
        targetThresholdCents: TARGET_THRESHOLD_CENTS,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

if (!dryRun) {
  d1Exec(
    `UPDATE company_commercial_settings
     SET auto_top_up_threshold_cents = ${TARGET_THRESHOLD_CENTS},
         auto_top_up_amount_cents = ${TARGET_AMOUNT_CENTS},
         updated_at = datetime('now')
     WHERE company_id = '${COMPANY_ID}'`,
  );
  d1Exec(
    `UPDATE payment_provider_accounts
     SET auto_top_up_threshold_cents = ${TARGET_THRESHOLD_CENTS},
         auto_top_up_amount_cents = ${TARGET_AMOUNT_CENTS},
         updated_at = datetime('now')
     WHERE company_id = '${COMPANY_ID}' AND provider = 'stripe'`,
  );
}

const after = d1Query(
  `SELECT auto_top_up_enabled, auto_top_up_threshold_cents, auto_top_up_amount_cents
   FROM company_commercial_settings WHERE company_id = '${COMPANY_ID}'`,
)[0];

console.log(
  JSON.stringify(
    {
      dryRun,
      balanceCents,
      before: settings,
      after,
      safeToLowerThreshold,
      note: "Configuration only — no auto top-up charge triggered by this script.",
    },
    null,
    2,
  ),
);
