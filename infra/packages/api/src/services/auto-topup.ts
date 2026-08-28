import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { appendLedgerEntry, getWalletBalance } from "./ledger";
import { getCompanySettings } from "./company-settings";
import { createNotification } from "./notifications";
import type { Env } from "../env";
import {
  stripePaymentsAllowed,
  ensureStripeCustomer,
  getStripeMode,
  isStripeTestModeActive,
  STRIPE_LIVE_MODE_ALLOWED,
} from "./stripe";
import { companyStripeCheckoutAllowed, getCompanyBillingMode } from "./company-billing-mode";

export async function companyLiveAutoTopUpEligible(
  env: Env,
  companyId: string,
): Promise<boolean> {
  if (getStripeMode(env) !== "live" || !STRIPE_LIVE_MODE_ALLOWED) return false;
  const companyBillingMode = await getCompanyBillingMode(env.DB, companyId);
  const checkoutGate = companyStripeCheckoutAllowed(env, companyBillingMode);
  return companyBillingMode === "live" && checkoutGate.allowed;
}

export const AUTO_TOPUP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const AUTO_TOPUP_MAX_AMOUNT_CENTS = 10000_00; // £10,000 cap per charge
export const AUTO_TOPUP_DEFAULT_DAILY_CAP_CENTS = 50000_00; // £500/day default
export const AUTO_TOPUP_DEFAULT_MONTHLY_CAP_CENTS = 200000_00; // £2,000/month default
export const AUTO_TOPUP_MAX_FAILURES_BEFORE_SUPPRESS = 3;
export const AUTO_TOPUP_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

export type AutoTopUpEvaluation = {
  shouldExecute: boolean;
  reason: string;
  amountCents?: number;
  thresholdCents?: number;
  portalStatus?: "disabled" | "configured" | "ready" | "awaiting_activation" | "active" | "suppressed" | "payment_failed";
};

async function getCommercialSafety(db: D1Database, companyId: string) {
  return db
    .prepare(
      `SELECT auto_top_up_monthly_cap_cents, auto_top_up_monthly_spent_cents, auto_top_up_month_key,
              auto_top_up_daily_cap_cents, auto_top_up_daily_spent_cents, auto_top_up_day_key,
              auto_top_up_failed_count, auto_top_up_suppressed_until, auto_top_up_last_failure_at
       FROM company_commercial_settings WHERE company_id = ?`,
    )
    .bind(companyId)
    .first();
}

export async function getAutoTopUpPortalStatus(
  db: D1Database,
  companyId: string,
  executionEnabled: boolean,
): Promise<AutoTopUpEvaluation["portalStatus"]> {
  const settings = await getCompanySettings(db, companyId);
  if (!settings?.autoTopUp.enabled) return "disabled";
  if (!settings.autoTopUp.paymentMethodReady) return "configured";
  const commercial = await getCommercialSafety(db, companyId);
  const suppressedUntil = commercial?.auto_top_up_suppressed_until
    ? String(commercial.auto_top_up_suppressed_until)
    : null;
  if (suppressedUntil && suppressedUntil > nowIso()) return "suppressed";
  const recentFail = await db
    .prepare(
      `SELECT id FROM auto_top_up_transactions
       WHERE company_id = ? AND status = 'failed' AND completed_at >= datetime('now', '-1 day')
       LIMIT 1`,
    )
    .bind(companyId)
    .first();
  if (recentFail) return "payment_failed";
  if (!executionEnabled) return "awaiting_activation";
  return "active";
}

export async function evaluateAutoTopUp(
  db: D1Database,
  companyId: string,
): Promise<AutoTopUpEvaluation> {
  const settings = await getCompanySettings(db, companyId);
  if (!settings?.autoTopUp.enabled) {
    return { shouldExecute: false, reason: "auto_topup_disabled" };
  }

  const threshold = settings.autoTopUp.thresholdCents ?? 500;
  const amount = settings.autoTopUp.amountCents ?? 2500;
  if (amount > AUTO_TOPUP_MAX_AMOUNT_CENTS) {
    return { shouldExecute: false, reason: "amount_exceeds_maximum" };
  }

  const provider = await db
    .prepare(
      `SELECT payment_method_id, payment_method_status, auto_top_up_enabled
       FROM payment_provider_accounts WHERE company_id = ? AND provider = 'stripe'`,
    )
    .bind(companyId)
    .first();

  if (!provider?.payment_method_id || String(provider.payment_method_status) !== "active") {
    return { shouldExecute: false, reason: "no_payment_method" };
  }

  const commercial = await getCommercialSafety(db, companyId);
  const suppressedUntil = commercial?.auto_top_up_suppressed_until
    ? String(commercial.auto_top_up_suppressed_until)
    : null;
  if (suppressedUntil && suppressedUntil > nowIso()) {
    return { shouldExecute: false, reason: "suppressed" };
  }

  const wallet = await getWalletBalance(db, companyId);
  if (wallet.balanceCents > threshold) {
    return { shouldExecute: false, reason: "balance_above_threshold" };
  }

  const pending = await db
    .prepare(
      `SELECT id FROM auto_top_up_transactions
       WHERE company_id = ? AND status IN ('pending', 'processing', 'payment_created')
       LIMIT 1`,
    )
    .bind(companyId)
    .first();
  if (pending) {
    return { shouldExecute: false, reason: "pending_transaction" };
  }

  const recentProcessing = await db
    .prepare(
      `SELECT id FROM auto_top_up_transactions
       WHERE company_id = ? AND status = 'completed' AND ledger_entry_id IS NULL
         AND created_at >= datetime('now', '-1 hour')
       LIMIT 1`,
    )
    .bind(companyId)
    .first();
  if (recentProcessing) {
    return { shouldExecute: false, reason: "awaiting_webhook_credit" };
  }

  const cooldownSince = new Date(Date.now() - AUTO_TOPUP_COOLDOWN_MS).toISOString();
  const recent = await db
    .prepare(
      `SELECT id FROM auto_top_up_transactions
       WHERE company_id = ? AND status = 'completed' AND completed_at >= ?
       LIMIT 1`,
    )
    .bind(companyId, cooldownSince)
    .first();
  if (recent) {
    return { shouldExecute: false, reason: "cooldown_active" };
  }

  const monthKey = new Date().toISOString().slice(0, 7);
  const dayKey = new Date().toISOString().slice(0, 10);

  let monthlySpent = Number(commercial?.auto_top_up_monthly_spent_cents ?? 0);
  if (String(commercial?.auto_top_up_month_key ?? "") !== monthKey) {
    monthlySpent = 0;
  }
  const monthlyCap =
    commercial?.auto_top_up_monthly_cap_cents != null
      ? Number(commercial.auto_top_up_monthly_cap_cents)
      : AUTO_TOPUP_DEFAULT_MONTHLY_CAP_CENTS;
  if (monthlySpent + amount > monthlyCap) {
    return { shouldExecute: false, reason: "monthly_cap_reached" };
  }

  let dailySpent = Number(commercial?.auto_top_up_daily_spent_cents ?? 0);
  if (String(commercial?.auto_top_up_day_key ?? "") !== dayKey) {
    dailySpent = 0;
  }
  const dailyCap =
    commercial?.auto_top_up_daily_cap_cents != null
      ? Number(commercial.auto_top_up_daily_cap_cents)
      : AUTO_TOPUP_DEFAULT_DAILY_CAP_CENTS;
  if (dailySpent + amount > dailyCap) {
    return { shouldExecute: false, reason: "daily_cap_reached" };
  }

  await recordAuditEvent(db, {
    companyId,
    eventType: "auto_topup.eligible",
    actor: "auto-topup-service",
    resourceType: "company_commercial_settings",
    resourceId: companyId,
    detail: { balanceCents: wallet.balanceCents, thresholdCents: threshold, amountCents: amount },
  });

  return {
    shouldExecute: true,
    reason: "eligible",
    amountCents: amount,
    thresholdCents: threshold,
  };
}

export async function createAutoTopUpTransaction(
  env: Env,
  input: {
    companyId: string;
    companyName: string;
    actorEmail: string;
    amountCents: number;
    triggerBalanceCents: number;
  },
): Promise<
  | { ok: true; transactionId: string; paymentIntentId: string; status: string }
  | { ok: false; error: string; code: string }
> {
  if (!stripePaymentsAllowed(env)) {
    return { ok: false, error: "Stripe payments not enabled", code: "PAYMENTS_BLOCKED" };
  }

  const companyBillingMode = await getCompanyBillingMode(env.DB, input.companyId);
  const checkoutGate = companyStripeCheckoutAllowed(env, companyBillingMode);
  if (!checkoutGate.allowed) {
    return {
      ok: false,
      error: checkoutGate.reason ?? "Auto top-up blocked for this company billing mode",
      code: "BILLING_MODE_BLOCKED",
    };
  }

  const liveEligible = await companyLiveAutoTopUpEligible(env, input.companyId);
  if (getStripeMode(env) === "live" && !liveEligible) {
    return {
      ok: false,
      error: "Live auto top-up is not enabled for this company billing mode",
      code: "LIVE_AUTO_TOPUP_BLOCKED",
    };
  }

  const idempotencyKey = `autotopup_${input.companyId}_${input.amountCents}_${Math.floor(Date.now() / AUTO_TOPUP_COOLDOWN_MS)}`;
  const existing = await env.DB.prepare(
    `SELECT id, status FROM auto_top_up_transactions WHERE company_id = ? AND idempotency_key = ?`,
  )
    .bind(input.companyId, idempotencyKey)
    .first();
  if (existing) {
    return {
      ok: false,
      error: "Duplicate auto top-up attempt",
      code: "DUPLICATE",
    };
  }

  const customer = await ensureStripeCustomer(env, {
    companyId: input.companyId,
    companyName: input.companyName,
    actorEmail: input.actorEmail,
  });
  if (!customer.ok) {
    return { ok: false, error: customer.error, code: "CUSTOMER_FAILED" };
  }

  const provider = await env.DB.prepare(
    `SELECT payment_method_id FROM payment_provider_accounts
     WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(input.companyId)
    .first();
  const paymentMethodId = provider?.payment_method_id
    ? String(provider.payment_method_id)
    : null;
  if (!paymentMethodId) {
    return { ok: false, error: "No saved payment method", code: "NO_PAYMENT_METHOD" };
  }

  const txId = newId("autotopup");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO auto_top_up_transactions (
      id, company_id, idempotency_key, amount_cents, currency, status,
      trigger_balance_cents, created_at
    ) VALUES (?, ?, ?, ?, 'GBP', 'pending', ?, ?)`,
  )
    .bind(txId, input.companyId, idempotencyKey, input.amountCents, input.triggerBalanceCents, now)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "auto_topup.payment_requested",
    actor: "auto-topup-service",
    resourceType: "auto_top_up_transaction",
    resourceId: txId,
    detail: { amountCents: input.amountCents, idempotencyKey },
  });

  const params = new URLSearchParams();
  params.set("amount", String(input.amountCents));
  params.set("currency", "gbp");
  params.set("customer", customer.customerId);
  params.set("payment_method", paymentMethodId);
  params.set("off_session", "true");
  params.set("confirm", "true");
  params.set("metadata[company_id]", input.companyId);
  params.set("metadata[infra_company_id]", input.companyId);
  params.set("metadata[auto_top_up_transaction_id]", txId);
  params.set("metadata[credit_class]", "paid");
  params.set("metadata[source]", "auto_top_up");

  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: params.toString(),
  });

  const body = (await response.json()) as {
    id?: string;
    status?: string;
    error?: { message?: string };
  };

  if (!response.ok || !body.id) {
    const errMsg = body.error?.message ?? "PaymentIntent creation failed";
    await env.DB.prepare(
      `UPDATE auto_top_up_transactions SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ?`,
    )
      .bind(errMsg, nowIso(), txId)
      .run();
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "auto_topup.failed",
      actor: "auto-topup-service",
      resourceType: "auto_top_up_transaction",
      resourceId: txId,
      detail: { reason: errMsg },
    });
    await createNotification(env.DB, {
      companyId: input.companyId,
      type: "auto_topup_failure",
      severity: "warning",
      title: "Auto top-up failed",
      body: errMsg,
      href: `/portal/${input.companyId}/billing?tab=auto-topup`,
      dedupKey: `auto_topup_fail_${txId}`,
    });
    return { ok: false, error: errMsg, code: "PAYMENT_INTENT_FAILED" };
  }

  await env.DB.prepare(
    `UPDATE auto_top_up_transactions
     SET status = 'payment_created', stripe_payment_intent_id = ?
     WHERE id = ?`,
  )
    .bind(body.id, txId)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "auto_topup.payment_created",
    actor: "auto-topup-service",
    resourceType: "auto_top_up_transaction",
    resourceId: txId,
    detail: { amountCents: input.amountCents, paymentIntentId: body.id, stripeStatus: body.status },
  });

  // Wallet credit ONLY via verified Stripe webhook — never on PaymentIntent creation alone.

  return {
    ok: true,
    transactionId: txId,
    paymentIntentId: body.id,
    status: body.status ?? "processing",
  };
}

export async function creditAutoTopUpFromPaymentIntent(
  env: Env,
  input: {
    stripeEventId: string;
    paymentIntentId: string;
    companyId: string;
    amountCents: number;
    transactionId?: string;
  },
): Promise<{ credited: boolean; duplicate: boolean }> {
  let txId = input.transactionId;
  if (!txId) {
    const tx = await env.DB.prepare(
      `SELECT id, status, ledger_entry_id FROM auto_top_up_transactions
       WHERE stripe_payment_intent_id = ? AND company_id = ?`,
    )
      .bind(input.paymentIntentId, input.companyId)
      .first();
    if (!tx) return { credited: false, duplicate: false };
    txId = String(tx.id);
    if (tx.ledger_entry_id) return { credited: false, duplicate: true };
  }

  const ledger = await appendLedgerEntry(env.DB, {
    companyId: input.companyId,
    entryType: "top_up",
    amountCents: input.amountCents,
    referenceType: "auto_top_up",
    referenceId: txId!,
    description: `Auto top-up £${(input.amountCents / 100).toFixed(2)}`,
    metadata: {
      creditClass: "paid",
      stripePaymentIntentId: input.paymentIntentId,
      stripeEventId: input.stripeEventId,
      source: "auto_top_up",
    },
    createdBy: "stripe-webhook",
  });

  const now = nowIso();
  await env.DB.prepare(
    `UPDATE auto_top_up_transactions
     SET status = 'credited', ledger_entry_id = ?, stripe_event_id = ?, completed_at = ?
     WHERE id = ?`,
  )
    .bind(ledger.entry.id, input.stripeEventId, now, txId)
    .run();

  const monthKey = now.slice(0, 7);
  const dayKey = now.slice(0, 10);
  await env.DB.prepare(
    `UPDATE company_commercial_settings
     SET auto_top_up_month_key = ?,
         auto_top_up_monthly_spent_cents = CASE
           WHEN auto_top_up_month_key = ? THEN COALESCE(auto_top_up_monthly_spent_cents, 0) + ?
           ELSE ?
         END,
         auto_top_up_day_key = ?,
         auto_top_up_daily_spent_cents = CASE
           WHEN auto_top_up_day_key = ? THEN COALESCE(auto_top_up_daily_spent_cents, 0) + ?
           ELSE ?
         END,
         auto_top_up_failed_count = 0,
         auto_top_up_suppressed_until = NULL,
         updated_at = ?
     WHERE company_id = ?`,
  )
    .bind(
      monthKey,
      monthKey,
      input.amountCents,
      input.amountCents,
      dayKey,
      dayKey,
      input.amountCents,
      input.amountCents,
      now,
      input.companyId,
    )
    .run();

  if (!ledger.alreadyExists) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "auto_topup.payment_succeeded",
      actor: "stripe-webhook",
      resourceType: "auto_top_up_transaction",
      resourceId: txId!,
      detail: { amountCents: input.amountCents, paymentIntentId: input.paymentIntentId },
    });
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "auto_topup.wallet_credited",
      actor: "stripe-webhook",
      resourceType: "ledger",
      resourceId: ledger.entry.id,
      detail: { amountCents: input.amountCents, transactionId: txId },
    });
    await createNotification(env.DB, {
      companyId: input.companyId,
      type: "auto_topup_success",
      severity: "info",
      title: "Auto top-up completed",
      body: `£${(input.amountCents / 100).toFixed(2)} was added to your wallet.`,
      href: null,
      dedupKey: `auto_topup_ok_${txId}`,
    });
  }

  return { credited: !ledger.alreadyExists, duplicate: ledger.alreadyExists };
}

export async function failAutoTopUpFromPaymentIntent(
  env: Env,
  input: {
    paymentIntentId: string;
    companyId: string;
    failureReason: string;
    stripeEventId: string;
  },
): Promise<void> {
  const tx = await env.DB.prepare(
    `SELECT id FROM auto_top_up_transactions WHERE stripe_payment_intent_id = ?`,
  )
    .bind(input.paymentIntentId)
    .first();
  if (!tx) return;

  await env.DB.prepare(
    `UPDATE auto_top_up_transactions
     SET status = 'failed', failure_reason = ?, stripe_event_id = ?, completed_at = ?
     WHERE id = ? AND status != 'credited'`,
  )
    .bind(input.failureReason, input.stripeEventId, nowIso(), tx.id)
    .run();

  const now = nowIso();
  const commercial = await env.DB.prepare(
    `SELECT auto_top_up_failed_count FROM company_commercial_settings WHERE company_id = ?`,
  )
    .bind(input.companyId)
    .first();
  const failCount = Number(commercial?.auto_top_up_failed_count ?? 0) + 1;
  const suppressedUntil =
    failCount >= AUTO_TOPUP_MAX_FAILURES_BEFORE_SUPPRESS
      ? new Date(Date.now() + AUTO_TOPUP_SUPPRESSION_MS).toISOString()
      : null;

  await env.DB.prepare(
    `UPDATE company_commercial_settings
     SET auto_top_up_failed_count = ?,
         auto_top_up_last_failure_at = ?,
         auto_top_up_suppressed_until = COALESCE(?, auto_top_up_suppressed_until),
         updated_at = ?
     WHERE company_id = ?`,
  )
    .bind(failCount, now, suppressedUntil, now, input.companyId)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: suppressedUntil ? "auto_topup.suppressed" : "auto_topup.payment_failed",
    actor: "stripe-webhook",
    resourceType: "auto_top_up_transaction",
    resourceId: String(tx.id),
    detail: { reason: input.failureReason, failCount, suppressedUntil },
  });

  await createNotification(env.DB, {
    companyId: input.companyId,
    type: "auto_topup_failure",
    severity: "warning",
    title: "Auto top-up failed",
    body: input.failureReason,
    href: null,
    dedupKey: `auto_topup_fail_${tx.id}`,
  });
}

/** Evaluate and optionally trigger auto top-up after wallet-changing events. */
export async function maybeTriggerAutoTopUp(
  env: Env,
  input: { companyId: string; companyName: string; actorEmail: string },
): Promise<{ triggered: boolean; reason: string }> {
  const executionEnabled =
    String(env.AUTO_TOPUP_EXECUTION_ENABLED ?? "").toLowerCase() === "true";
  if (!executionEnabled) {
    return { triggered: false, reason: "execution_disabled" };
  }

  const evaluation = await evaluateAutoTopUp(env.DB, input.companyId);
  if (!evaluation.shouldExecute || !evaluation.amountCents) {
    return { triggered: false, reason: evaluation.reason };
  }

  const wallet = await getWalletBalance(env.DB, input.companyId);
  const result = await createAutoTopUpTransaction(env, {
    companyId: input.companyId,
    companyName: input.companyName,
    actorEmail: input.actorEmail,
    amountCents: evaluation.amountCents,
    triggerBalanceCents: wallet.balanceCents,
  });

  if (!result.ok) {
    return { triggered: false, reason: result.code };
  }
  return { triggered: true, reason: "initiated" };
}

export type AutoTopUpDiagnostics = {
  enabled: boolean;
  executionEnabled: boolean;
  thresholdCents: number | null;
  amountCents: number | null;
  portalStatus: AutoTopUpEvaluation["portalStatus"];
  evaluation: AutoTopUpEvaluation;
  paymentMethod: {
    ready: boolean;
    brand: string | null;
    last4: string | null;
    status: string | null;
  };
  lastAttempt: {
    id: string;
    status: string;
    amountCents: number;
    failureReason: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
  lastSuccess: {
    id: string;
    amountCents: number;
    completedAt: string | null;
  } | null;
  lastFailure: {
    id: string;
    amountCents: number;
    failureReason: string | null;
    completedAt: string | null;
  } | null;
  dailySpentCents: number;
  dailyCapCents: number;
  monthlySpentCents: number;
  monthlyCapCents: number;
  suppressedUntil: string | null;
  failureCount: number;
  liveEligible: boolean;
  executionGateLabel: string;
};

export async function getAutoTopUpDiagnostics(
  env: Env,
  companyId: string,
): Promise<AutoTopUpDiagnostics> {
  const executionEnabled =
    String(env.AUTO_TOPUP_EXECUTION_ENABLED ?? "").toLowerCase() === "true";
  const settings = await getCompanySettings(env.DB, companyId);
  const commercial = await getCommercialSafety(env.DB, companyId);
  const provider = await env.DB.prepare(
    `SELECT payment_method_brand, payment_method_last4, payment_method_status
     FROM payment_provider_accounts WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(companyId)
    .first();

  const evaluation = await evaluateAutoTopUp(env.DB, companyId);
  const portalStatus = await getAutoTopUpPortalStatus(env.DB, companyId, executionEnabled);
  const liveEligible = await companyLiveAutoTopUpEligible(env, companyId);
  const paymentMethodReady = Boolean(settings?.autoTopUp.paymentMethodReady);
  const autoTopUpEnabled = Boolean(settings?.autoTopUp.enabled);
  let executionGateLabel = "Disabled (production safe)";
  if (liveEligible) {
    if (!paymentMethodReady) {
      executionGateLabel = "Ready for live auto top-up — add a payment method to activate.";
    } else if (!autoTopUpEnabled) {
      executionGateLabel = "Live auto top-up available — enable explicitly to activate.";
    } else if (
      autoTopUpEnabled &&
      paymentMethodReady &&
      executionEnabled &&
      liveEligible
    ) {
      executionGateLabel = "Active in live billing mode";
    } else {
      executionGateLabel = "Configured — awaiting operator execution gate";
    }
  } else if (isStripeTestModeActive(env)) {
    executionGateLabel = executionEnabled
      ? autoTopUpEnabled && paymentMethodReady
        ? "Active in Stripe test mode"
        : "Available in Stripe test mode"
      : "Disabled until operator enables test execution";
  }

  const lastAttemptRow = await env.DB.prepare(
    `SELECT id, status, amount_cents, failure_reason, created_at, completed_at
     FROM auto_top_up_transactions WHERE company_id = ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first();

  const lastSuccessRow = await env.DB.prepare(
    `SELECT id, amount_cents, completed_at FROM auto_top_up_transactions
     WHERE company_id = ? AND status = 'completed'
     ORDER BY completed_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first();

  const lastFailureRow = await env.DB.prepare(
    `SELECT id, amount_cents, failure_reason, completed_at FROM auto_top_up_transactions
     WHERE company_id = ? AND status = 'failed'
     ORDER BY completed_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first();

  const monthKey = new Date().toISOString().slice(0, 7);
  const dayKey = new Date().toISOString().slice(0, 10);
  let monthlySpent = Number(commercial?.auto_top_up_monthly_spent_cents ?? 0);
  if (String(commercial?.auto_top_up_month_key ?? "") !== monthKey) monthlySpent = 0;
  let dailySpent = Number(commercial?.auto_top_up_daily_spent_cents ?? 0);
  if (String(commercial?.auto_top_up_day_key ?? "") !== dayKey) dailySpent = 0;

  return {
    enabled: Boolean(settings?.autoTopUp.enabled),
    executionEnabled,
    thresholdCents: settings?.autoTopUp.thresholdCents ?? null,
    amountCents: settings?.autoTopUp.amountCents ?? null,
    portalStatus,
    evaluation,
    paymentMethod: {
      ready: Boolean(settings?.autoTopUp.paymentMethodReady),
      brand: provider?.payment_method_brand ? String(provider.payment_method_brand) : null,
      last4: provider?.payment_method_last4 ? String(provider.payment_method_last4) : null,
      status: provider?.payment_method_status ? String(provider.payment_method_status) : null,
    },
    lastAttempt: lastAttemptRow
      ? {
          id: String(lastAttemptRow.id),
          status: String(lastAttemptRow.status),
          amountCents: Number(lastAttemptRow.amount_cents),
          failureReason: lastAttemptRow.failure_reason
            ? String(lastAttemptRow.failure_reason)
            : null,
          createdAt: String(lastAttemptRow.created_at),
          completedAt: lastAttemptRow.completed_at ? String(lastAttemptRow.completed_at) : null,
        }
      : null,
    lastSuccess: lastSuccessRow
      ? {
          id: String(lastSuccessRow.id),
          amountCents: Number(lastSuccessRow.amount_cents),
          completedAt: lastSuccessRow.completed_at ? String(lastSuccessRow.completed_at) : null,
        }
      : null,
    lastFailure: lastFailureRow
      ? {
          id: String(lastFailureRow.id),
          amountCents: Number(lastFailureRow.amount_cents),
          failureReason: lastFailureRow.failure_reason
            ? String(lastFailureRow.failure_reason)
            : null,
          completedAt: lastFailureRow.completed_at ? String(lastFailureRow.completed_at) : null,
        }
      : null,
    dailySpentCents: dailySpent,
    dailyCapCents:
      commercial?.auto_top_up_daily_cap_cents != null
        ? Number(commercial.auto_top_up_daily_cap_cents)
        : AUTO_TOPUP_DEFAULT_DAILY_CAP_CENTS,
    monthlySpentCents: monthlySpent,
    monthlyCapCents:
      commercial?.auto_top_up_monthly_cap_cents != null
        ? Number(commercial.auto_top_up_monthly_cap_cents)
        : AUTO_TOPUP_DEFAULT_MONTHLY_CAP_CENTS,
    suppressedUntil: commercial?.auto_top_up_suppressed_until
      ? String(commercial.auto_top_up_suppressed_until)
      : null,
    failureCount: Number(commercial?.auto_top_up_failed_count ?? 0),
    liveEligible,
    executionGateLabel,
  };
}
