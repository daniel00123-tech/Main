#!/usr/bin/env node
/**
 * Stripe live acceptance readiness probe — never prints secret values.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

const health = await fetch(`${API}/api/gateway/v1/health`).then((r) => r.json());
const secrets = execFileSync("npx", ["wrangler", "secret", "list"], {
  cwd: apiDir,
  encoding: "utf8",
});
const secretNames = [...secrets.matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]);
const companies = d1Query(
  `SELECT id, slug, billing_mode FROM companies WHERE id IN ('co_caddington','co_ht','co_el') ORDER BY id`,
);
const caddingtonWallet = d1Query(
  `SELECT balance_cents, stripe_customer_id FROM credit_balances WHERE company_id = 'co_caddington'`,
);
const promoSample = d1Query(
  `SELECT company_id, amount_cents, reason, granted_by, created_at FROM promotional_credit_grants WHERE company_id = 'co_caddington' ORDER BY created_at DESC LIMIT 1`,
);

const checks = [
  {
    id: "stripe_secret_configured",
    pass: secretNames.includes("STRIPE_SECRET_KEY"),
    detail: "STRIPE_SECRET_KEY secret present",
  },
  {
    id: "stripe_webhook_secret_configured",
    pass: secretNames.includes("STRIPE_WEBHOOK_SECRET"),
    detail: "STRIPE_WEBHOOK_SECRET secret present",
  },
  {
    id: "platform_stripe_mode_reported",
    pass: health.stripeMode === "test" || health.stripeMode === "live",
    detail: `health.stripeMode=${health.stripeMode}`,
  },
  {
    id: "live_mode_not_auto_enabled",
    pass: health.stripeMode !== "live" || health.stripePaymentsAllowed === false,
    detail: `stripePaymentsAllowed=${health.stripePaymentsAllowed}`,
  },
  {
    id: "caddington_stripe_customer",
    pass: Boolean(caddingtonWallet[0]?.stripe_customer_id),
    detail: caddingtonWallet[0]?.stripe_customer_id ? "customer id present" : "missing",
  },
  {
    id: "ht_el_remain_test",
    pass: companies.every((c) => c.id === "co_caddington" || c.billing_mode === "test"),
    detail: companies.map((c) => `${c.slug}:${c.billing_mode}`).join(", "),
  },
  {
    id: "promotional_grants_auditable",
    pass: promoSample.length === 0 || Boolean(promoSample[0]?.granted_by),
    detail: promoSample[0] ? "grant row includes granted_by" : "no promo rows (ok)",
  },
];

console.log(
  JSON.stringify(
    {
      title: "STRIPE LIVE READINESS PROBE",
      checkedAt: new Date().toISOString(),
      health: {
        stripeConfigured: health.stripeConfigured,
        stripeMode: health.stripeMode,
        stripePaymentsAllowed: health.stripePaymentsAllowed,
      },
      companies,
      caddingtonWallet: {
        balanceCents: caddingtonWallet[0]?.balance_cents ?? null,
        hasStripeCustomer: Boolean(caddingtonWallet[0]?.stripe_customer_id),
      },
      checks,
      allPass: checks.every((c) => c.pass),
      note: "Does not expose secret values. Does not create charges.",
    },
    null,
    2,
  ),
);
