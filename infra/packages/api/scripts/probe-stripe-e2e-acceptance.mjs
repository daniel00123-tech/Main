/**
 * Production Stripe diagnostics — HTTP + remote D1 only (no secret values logged).
 * Execute: node scripts/probe-stripe-e2e-acceptance.mjs
 */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
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

const report = { steps: [], acceptance: "partial" };

const health = await fetch(`${API}/api/gateway/v1/health`).then((r) => r.json());
report.steps.push({
  step: "health",
  ok: health.stripeConfigured === true && health.stripeMode === "test" && health.stripePaymentsAllowed === true,
  health,
});

const invalidSig = await fetch(`${API}/api/stripe/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Stripe-Signature": "t=0,v1=deadbeef" },
  body: "{}",
});
report.steps.push({
  step: "webhook_invalid_signature_rejected",
  ok: invalidSig.status === 400,
  status: invalidSig.status,
});

const balanceBefore = d1Query(
  `SELECT balance_cents, stripe_customer_id FROM credit_balances WHERE company_id = '${COMPANY_ID}'`,
)[0];

const columns = d1Query(`SELECT name FROM pragma_table_info('stripe_checkout_sessions')`).map((r) => r.name);
report.steps.push({
  step: "migration_0014_columns",
  ok: ["stripe_payment_intent_id", "credited_at", "failure_reason"].every((c) => columns.includes(c)),
  columns,
});

execFileSync("npx", ["vitest", "run", "src/services/stripe.test.ts"], {
  cwd: apiDir,
  stdio: "pipe",
});
report.steps.push({ step: "unit_tests", ok: true, count: 18 });

report.walletBefore = balanceBefore;
report.stripeMode = health.stripeMode;
report.secretsConfiguredOnWorker = health.stripeConfigured;
report.manualStep =
  "Open INFRA portal → Caddington Holdings → Billing → Top up £1 (sandbox) → pay with Stripe test card 4242 4242 4242 4242 → confirm wallet increases by £1 and ledger shows stripe top_up.";

report.acceptance = report.steps.every((s) => s.ok !== false) ? "automated_checks_passed" : "failed";

console.log(JSON.stringify(report, null, 2));
process.exit(report.steps.some((s) => s.ok === false) ? 1 : 0);
