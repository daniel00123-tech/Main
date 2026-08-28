#!/usr/bin/env node
/**
 * Stripe live activation gate — isolation + checkout readiness (no completed payment).
 * Never prints secret values.
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

function runVitest(pattern) {
  try {
    execFileSync(
      "npx",
      ["vitest", "run", pattern, "--reporter=dot"],
      { cwd: apiDir, encoding: "utf8", stdio: "pipe" },
    );
    return { pass: true };
  } catch (err) {
    return { pass: false, detail: String(err.stdout ?? err.message).slice(-400) };
  }
}

const health = await fetch(`${API}/api/gateway/v1/health`).then((r) => r.json());
const companies = d1Query(
  `SELECT id, slug, billing_mode FROM companies WHERE id IN ('co_caddington','co_ht','co_el','co_infra_test') ORDER BY id`,
);
const balances = d1Query(
  `SELECT company_id, balance_cents FROM credit_balances WHERE company_id IN ('co_caddington','co_ht','co_el')`,
);
const ledgerCounts = d1Query(
  `SELECT company_id, COUNT(*) AS entries FROM ledger_entries WHERE company_id IN ('co_caddington','co_ht','co_el') GROUP BY company_id`,
);
const caddingtonCredits = d1Query(
  `SELECT entry_type, amount_cents, metadata_json, created_at FROM ledger_entries WHERE company_id = 'co_caddington' AND amount_cents > 0 ORDER BY created_at DESC LIMIT 20`,
);

let paidCents = 0;
let promoCents = 0;
for (const row of caddingtonCredits) {
  try {
    const meta = JSON.parse(String(row.metadata_json ?? "{}"));
    if (row.entry_type === "top_up" || meta.creditClass === "paid") paidCents += Number(row.amount_cents);
    if (row.entry_type === "promotional_credit" || meta.creditClass === "test") promoCents += Number(row.amount_cents);
  } catch {
    if (row.entry_type === "top_up") paidCents += Number(row.amount_cents);
    if (row.entry_type === "promotional_credit") promoCents += Number(row.amount_cents);
  }
}

const latestLedger = d1Query(
  `SELECT id, entry_type, amount_cents, created_at FROM ledger_entries WHERE company_id = 'co_caddington' ORDER BY created_at DESC LIMIT 1`,
)[0];

const testRuns = {
  stripeBilling: runVitest("src/services/stripe.test.ts"),
  companyBillingMode: runVitest("src/services/company-billing-mode.test.ts"),
  promotionalGrants: runVitest("src/services/promotional-grants.test.ts"),
  financialIntegrity: runVitest("src/services/financial-integrity.test.ts"),
};

const caddington = companies.find((c) => c.id === "co_caddington");
const ht = companies.find((c) => c.id === "co_ht");
const el = companies.find((c) => c.id === "co_el");
const defaultCo = companies.find((c) => c.id === "co_infra_test");

const isolation = {
  caddingtonBillingLive: caddington?.billing_mode === "live",
  htBillingTest: ht?.billing_mode === "test",
  elBillingTest: el?.billing_mode === "test",
  defaultNonLive: !defaultCo || defaultCo.billing_mode !== "live",
  walletScoped: balances.length >= 2,
  ledgerScoped: ledgerCounts.length >= 1,
  livePlatform: health.stripeMode === "live",
  livePaymentsAllowed: health.stripePaymentsAllowed === true,
  liveAcceptanceAmountCents: LIVE_ACCEPTANCE_AMOUNT_CENTS,
};

const allPass =
  isolation.caddingtonBillingLive &&
  isolation.htBillingTest &&
  isolation.elBillingTest &&
  isolation.defaultNonLive &&
  isolation.livePlatform &&
  isolation.livePaymentsAllowed &&
  Object.values(testRuns).every((t) => t.pass);

console.log(
  JSON.stringify(
    {
      title: "STRIPE LIVE ACTIVATION GATE",
      checkedAt: new Date().toISOString(),
      health,
      isolation,
      testRuns,
      prePaymentBaseline: {
        caddington: {
          purchasedFundsCents: paidCents,
          promotionalCreditCents: promoCents,
          totalBalanceCents: balances.find((b) => b.company_id === "co_caddington")?.balance_cents ?? null,
          latestLedgerEntryId: latestLedger?.id ?? null,
          latestLedgerEntryType: latestLedger?.entry_type ?? null,
          stripeCustomerPresent: Boolean(
            d1Query(
              `SELECT stripe_customer_id FROM credit_balances WHERE company_id = 'co_caddington'`,
            )[0]?.stripe_customer_id,
          ),
        },
        ht: {
          balanceCents: balances.find((b) => b.company_id === "co_ht")?.balance_cents ?? null,
        },
        el: {
          balanceCents: balances.find((b) => b.company_id === "co_el")?.balance_cents ?? null,
        },
      },
      classification: allPass ? "READY_FOR_HUMAN_PAYMENT" : "PARTIAL",
      portalPath: "/portal/caddington-holdings/billing",
      portalUrl: "https://infra-web.pages.dev/portal/caddington-holdings/billing",
      humanPayment: {
        amountGbp: 1,
        amountCents: 100,
        instruction:
          "Daniel: open portal Billing → Add credit → tap £1.00 → complete Stripe Checkout manually. Then run verify-stripe-live-1-gbp-acceptance.mjs",
      },
      note: "No checkout completed and no wallet credit performed by this probe.",
    },
    null,
    2,
  ),
);

process.exit(allPass ? 0 : 1);
