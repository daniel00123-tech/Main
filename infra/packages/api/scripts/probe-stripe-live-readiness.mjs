#!/usr/bin/env node
/**
 * Stripe live acceptance readiness probe — never prints secret values.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const LIVE_ACCEPTANCE_AMOUNT_CENTS = 100;
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
const webhookProbe = await fetch(`${API}/api/stripe/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Stripe-Signature": "t=0,v1=invalid",
  },
  body: "{}",
});
const secrets = execFileSync("npx", ["wrangler", "secret", "list"], {
  cwd: apiDir,
  encoding: "utf8",
});
const secretNames = [...secrets.matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]);
const companies = d1Query(
  `SELECT id, slug, billing_mode FROM companies WHERE id IN ('co_caddington','co_ht','co_el') ORDER BY id`,
);
const defaultCompany = d1Query(
  `SELECT id, slug, billing_mode FROM companies WHERE id NOT IN ('co_caddington','co_ht','co_el') ORDER BY created_at DESC LIMIT 1`,
)[0];
const caddingtonWallet = d1Query(
  `SELECT balance_cents, stripe_customer_id FROM credit_balances WHERE company_id = 'co_caddington'`,
);
const promoSample = d1Query(
  `SELECT company_id, amount_cents, reason, granted_by, created_at FROM promotional_credit_grants WHERE company_id = 'co_caddington' ORDER BY created_at DESC LIMIT 1`,
);

const caddington = companies.find((c) => c.id === "co_caddington");
const ht = companies.find((c) => c.id === "co_ht");
const el = companies.find((c) => c.id === "co_el");

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
    id: "platform_stripe_mode_live",
    pass: health.stripeMode === "live",
    detail: `health.stripeMode=${health.stripeMode}`,
  },
  {
    id: "live_mode_allowed",
    pass: health.stripeMode !== "live" || health.stripePaymentsAllowed === true,
    detail: `stripePaymentsAllowed=${health.stripePaymentsAllowed}`,
  },
  {
    id: "webhook_endpoint_rejects_invalid_signature",
    pass: webhookProbe.status === 400,
    detail: `POST /api/stripe/webhook invalid signature -> ${webhookProbe.status}`,
  },
  {
    id: "caddington_billing_live",
    pass: caddington?.billing_mode === "live",
    detail: `caddington-holdings:${caddington?.billing_mode ?? "missing"}`,
  },
  {
    id: "caddington_stripe_customer",
    pass: Boolean(caddingtonWallet[0]?.stripe_customer_id),
    detail: caddingtonWallet[0]?.stripe_customer_id ? "customer id present" : "missing",
  },
  {
    id: "ht_remains_test",
    pass: ht?.billing_mode === "test",
    detail: `ht-business:${ht?.billing_mode ?? "missing"}`,
  },
  {
    id: "el_remains_test",
    pass: el?.billing_mode === "test",
    detail: `el-business:${el?.billing_mode ?? "missing"}`,
  },
  {
    id: "default_company_non_live",
    pass: !defaultCompany || defaultCompany.billing_mode !== "live",
    detail: defaultCompany
      ? `${defaultCompany.slug}:${defaultCompany.billing_mode}`
      : "no other companies (ok)",
  },
  {
    id: "live_acceptance_amount_cents",
    pass: LIVE_ACCEPTANCE_AMOUNT_CENTS === 100,
    detail: `£1.00 GBP / ${LIVE_ACCEPTANCE_AMOUNT_CENTS} pence`,
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
      liveAcceptanceAmountGbp: LIVE_ACCEPTANCE_AMOUNT_CENTS / 100,
      liveAcceptanceAmountCents: LIVE_ACCEPTANCE_AMOUNT_CENTS,
      health: {
        stripeConfigured: health.stripeConfigured,
        stripeMode: health.stripeMode,
        stripePaymentsAllowed: health.stripePaymentsAllowed,
      },
      companies,
      defaultCompany: defaultCompany ?? null,
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

process.exit(checks.every((c) => c.pass) ? 0 : 1);
