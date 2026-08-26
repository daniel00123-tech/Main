#!/usr/bin/env node
/** Post-payment verification for Stripe sandbox acceptance — never prints secrets. */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const COMPANY_ID = "co_caddington";
const SLUG = "caddington-holdings";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

const health = await fetch(`${API}/api/gateway/v1/health`).then((r) => r.json());
const balance = d1Query(
  `SELECT balance_cents, stripe_customer_id FROM credit_balances WHERE company_id = '${COMPANY_ID}'`,
);
const recentCheckouts = d1Query(
  `SELECT id, amount_cents, currency, status, stripe_session_id, stripe_mode, credited_at, failure_reason, created_at FROM stripe_checkout_sessions WHERE company_id = '${COMPANY_ID}' ORDER BY created_at DESC LIMIT 5`,
);
const recentLedger = d1Query(
  `SELECT id, entry_type, amount_cents, reference_type, reference_id, metadata_json, created_at FROM ledger_entries WHERE company_id = '${COMPANY_ID}' ORDER BY created_at DESC LIMIT 5`,
);
const recentWebhooks = d1Query(
  `SELECT stripe_event_id, event_type, processed, received_at, processed_at, error_message FROM stripe_webhook_events ORDER BY received_at DESC LIMIT 5`,
);
const recentAudit = d1Query(
  `SELECT event_type, actor, resource_type, resource_id, detail_json, created_at FROM audit_events WHERE company_id = '${COMPANY_ID}' AND event_type IN ('topup.requested','checkout.created','payment.confirmed','wallet.credited') ORDER BY created_at DESC LIMIT 10`,
);

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      health,
      wallet: balance[0] ?? null,
      recentCheckouts,
      recentLedger,
      recentWebhooks,
      recentAudit,
      portalWalletPath: `/api/companies/${SLUG}/wallet`,
    },
    null,
    2,
  ),
);
