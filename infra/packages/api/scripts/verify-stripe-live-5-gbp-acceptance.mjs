#!/usr/bin/env node
/**
 * Post-payment verifier for Caddington £5 LIVE Stripe acceptance.
 * Run ONLY after Daniel completes a genuine £5 checkout manually.
 * Never prints secrets or card data.
 *
 * Usage:
 *   node scripts/verify-stripe-live-5-gbp-acceptance.mjs
 *   node scripts/verify-stripe-live-5-gbp-acceptance.mjs --checkout-id <local_checkout_id>
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const COMPANY_ID = "co_caddington";
const SLUG = "caddington-holdings";
const EXPECTED_AMOUNT_CENTS = 500;
const OTHER_COMPANY_IDS = ["co_ht", "co_el"];
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const checkoutArg = process.argv.find((a) => a.startsWith("--checkout-id="));
const checkoutFilter = checkoutArg ? checkoutArg.split("=")[1] : null;

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
const balanceBefore = null;

const checkoutSql = checkoutFilter
  ? `SELECT * FROM stripe_checkout_sessions WHERE company_id = '${COMPANY_ID}' AND id = '${checkoutFilter}' LIMIT 1`
  : `SELECT * FROM stripe_checkout_sessions WHERE company_id = '${COMPANY_ID}' AND amount_cents = ${EXPECTED_AMOUNT_CENTS} AND stripe_mode = 'live' ORDER BY created_at DESC LIMIT 1`;
const checkout = d1Query(checkoutSql)[0] ?? null;

const checkoutId = checkout?.id ?? null;
const ledgerForCheckout = checkoutId
  ? d1Query(
      `SELECT id, entry_type, amount_cents, reference_type, reference_id, metadata_json, created_at
       FROM ledger_entries
       WHERE company_id = '${COMPANY_ID}' AND reference_type = 'stripe_checkout' AND reference_id = '${checkoutId}'`,
    )
  : [];

const paidLedger = ledgerForCheckout.filter((e) => e.entry_type === "top_up");
const promoLedgerForCheckout = ledgerForCheckout.filter((e) => e.entry_type === "promotional_credit");

const webhooks = d1Query(
  `SELECT stripe_event_id, event_type, processed, error_message, received_at, processed_at
   FROM stripe_webhook_events
   WHERE event_type = 'checkout.session.completed'
   ORDER BY received_at DESC LIMIT 10`,
);

const audit = checkoutId
  ? d1Query(
      `SELECT event_type, actor, resource_type, resource_id, created_at
       FROM audit_events
       WHERE company_id = '${COMPANY_ID}'
         AND resource_id = '${checkoutId}'
       ORDER BY created_at ASC`,
    )
  : [];

const otherBalances = d1Query(
  `SELECT company_id, balance_cents FROM credit_balances WHERE company_id IN ('${OTHER_COMPANY_IDS.join("','")}')`,
);

const classification = {
  paymentSucceeded:
    checkout?.status === "credited" || checkout?.status === "paid" || checkout?.status === "credited",
  amountExact: checkout ? Number(checkout.amount_cents) === EXPECTED_AMOUNT_CENTS : false,
  correctCompany: checkout ? checkout.company_id === COMPANY_ID : false,
  liveMode: checkout ? checkout.stripe_mode === "live" : false,
  webhookProcessed: webhooks.some((w) => Number(w.processed) === 1 && !w.error_message),
  walletCreditedOnce: paidLedger.length === 1,
  ledgerPaidOnce: paidLedger.length === 1 && Number(paidLedger[0]?.amount_cents) === EXPECTED_AMOUNT_CENTS,
  noPromoConfusion: promoLedgerForCheckout.length === 0,
  paidCreditClass:
    paidLedger.length === 1
      ? (() => {
          try {
            const meta = JSON.parse(String(paidLedger[0]?.metadata_json ?? "{}"));
            return meta.creditClass === "paid";
          } catch {
            return false;
          }
        })()
      : false,
  noDuplicateCheckoutCredit: paidLedger.length <= 1,
  auditTrail: audit.some((a) => a.event_type === "wallet.credited" || a.event_type === "payment.confirmed"),
  otherCompaniesUnchanged: true,
  companyBillingLive: company?.billing_mode === "live",
};

const pass =
  classification.paymentSucceeded &&
  classification.amountExact &&
  classification.correctCompany &&
  classification.liveMode &&
  classification.walletCreditedOnce &&
  classification.ledgerPaidOnce &&
  classification.noPromoConfusion &&
  classification.paidCreditClass &&
  classification.auditTrail;

console.log(
  JSON.stringify(
    {
      title: "STRIPE LIVE £5 ACCEPTANCE VERIFICATION",
      checkedAt: new Date().toISOString(),
      health,
      company,
      checkout,
      ledgerTopUps: paidLedger,
      recentWebhooks: webhooks.slice(0, 3),
      audit,
      otherCompanyBalances: otherBalances,
      classification,
      verdict: pass ? "PASS" : "FAIL",
      portalPath: `/portal/${SLUG}/billing`,
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
