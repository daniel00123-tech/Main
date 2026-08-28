#!/usr/bin/env node
/**
 * Production acceptance probe for Stripe payment-method setup flow.
 * Does NOT complete card entry. Optionally validates redirect URL when INFRA_SESSION_COOKIE is set.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const SLUG = "caddington-holdings";
const COMPANY_ID = "co_caddington";
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
const company = d1Query(
  `SELECT id, slug, billing_mode FROM companies WHERE id = '${COMPANY_ID}' LIMIT 1`,
)[0];
const wallet = d1Query(
  `SELECT stripe_customer_id FROM credit_balances WHERE company_id = '${COMPANY_ID}' LIMIT 1`,
)[0];
const provider = d1Query(
  `SELECT external_customer_ref, metadata_json, payment_method_id FROM payment_provider_accounts WHERE company_id = '${COMPANY_ID}' AND provider = 'stripe' LIMIT 1`,
)[0];

let setupProbe = null;
const cookie = process.env.INFRA_SESSION_COOKIE?.trim();
if (cookie) {
  const res = await fetch(`${API}/api/companies/${SLUG}/wallet/payment-method/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: "{}",
  });
  const body = await res.json().catch(() => ({}));
  setupProbe = {
    status: res.status,
    hasUrl: typeof body.url === "string" && body.url.startsWith("https://checkout.stripe.com/"),
    testMode: body.testMode,
    stripeConfigured: body.stripeConfigured,
    error: body.error ?? null,
  };
}

const checks = [
  {
    id: "platform_stripe_live",
    pass: health.stripeMode === "live",
    detail: `stripeMode=${health.stripeMode}`,
  },
  {
    id: "caddington_billing_live",
    pass: company?.billing_mode === "live",
    detail: `billing_mode=${company?.billing_mode ?? "missing"}`,
  },
  {
    id: "stripe_payments_allowed",
    pass: health.stripePaymentsAllowed === true,
    detail: `stripePaymentsAllowed=${health.stripePaymentsAllowed}`,
  },
  {
    id: "customer_ref_present_or_repairable",
    pass: Boolean(wallet?.stripe_customer_id || provider?.external_customer_ref),
    detail: `credit_balances.stripe_customer_id=${wallet?.stripe_customer_id ?? "null"}`,
  },
  {
    id: "no_saved_payment_method_yet",
    pass: !provider?.payment_method_id,
    detail: `payment_method_id=${provider?.payment_method_id ?? "null"}`,
  },
];

if (setupProbe) {
  checks.push({
    id: "setup_endpoint_returns_stripe_url",
    pass: setupProbe.status === 200 && setupProbe.hasUrl,
    detail: JSON.stringify(setupProbe),
  });
}

const ht = d1Query(`SELECT billing_mode FROM companies WHERE id = 'co_ht' LIMIT 1`)[0];
const el = d1Query(`SELECT billing_mode FROM companies WHERE id = 'co_el' LIMIT 1`)[0];
checks.push(
  {
    id: "ht_remains_test_billing",
    pass: ht?.billing_mode === "test",
    detail: `ht billing_mode=${ht?.billing_mode ?? "missing"}`,
  },
  {
    id: "elvex_remains_test_billing",
    pass: el?.billing_mode === "test",
    detail: `elvex billing_mode=${el?.billing_mode ?? "missing"}`,
  },
);

const result = {
  classification: checks.every((check) => check.pass)
    ? setupProbe
      ? "PASS"
      : "PARTIAL"
    : "FAIL",
  note: setupProbe
    ? "Setup endpoint verified with session cookie — no card entered."
    : "Set INFRA_SESSION_COOKIE to verify live setup redirect URL without entering a card.",
  portalUrl: `https://infra-web.pages.dev/portal/${SLUG}/billing?tab=payment`,
  checks,
  providerMetadata: provider?.metadata_json ?? null,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.classification === "FAIL" ? 1 : 0);
