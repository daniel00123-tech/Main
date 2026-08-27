import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { appendLedgerEntry, getWalletBalance } from "./ledger";
import { getCompanySettings } from "./company-settings";
import { createNotification } from "./notifications";
import type { Env } from "../env";
import { stripePaymentsAllowed, ensureStripeCustomer } from "./stripe";

export const AUTO_TOPUP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const AUTO_TOPUP_MAX_AMOUNT_CENTS = 10000_00; // £10,000 cap per charge

export type AutoTopUpEvaluation = {
  shouldExecute: boolean;
  reason: string;
  amountCents?: number;
  thresholdCents?: number;
};

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

  const wallet = await getWalletBalance(db, companyId);
  if (wallet.balanceCents > threshold) {
    return { shouldExecute: false, reason: "balance_above_threshold" };
  }

  const pending = await db
    .prepare(
      `SELECT id FROM auto_top_up_transactions
       WHERE company_id = ? AND status IN ('pending', 'processing')
       LIMIT 1`,
    )
    .bind(companyId)
    .first();
  if (pending) {
    return { shouldExecute: false, reason: "pending_transaction" };
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
  const commercial = await db
    .prepare(
      `SELECT auto_top_up_monthly_cap_cents, auto_top_up_monthly_spent_cents, auto_top_up_month_key
       FROM company_commercial_settings WHERE company_id = ?`,
    )
    .bind(companyId)
    .first();

  let monthlySpent = Number(commercial?.auto_top_up_monthly_spent_cents ?? 0);
  if (String(commercial?.auto_top_up_month_key ?? "") !== monthKey) {
    monthlySpent = 0;
  }
  const monthlyCap = commercial?.auto_top_up_monthly_cap_cents
    ? Number(commercial.auto_top_up_monthly_cap_cents)
    : null;
  if (monthlyCap != null && monthlySpent + amount > monthlyCap) {
    return { shouldExecute: false, reason: "monthly_cap_reached" };
  }

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
     SET status = 'processing', stripe_payment_intent_id = ?
     WHERE id = ?`,
  )
    .bind(body.id, txId)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "auto_topup.initiated",
    actor: "auto-topup-service",
    resourceType: "auto_top_up_transaction",
    resourceId: txId,
    detail: { amountCents: input.amountCents, paymentIntentId: body.id },
  });

  if (body.status === "succeeded") {
    await creditAutoTopUpFromPaymentIntent(env, {
      stripeEventId: `pi_direct_${body.id}`,
      paymentIntentId: body.id,
      companyId: input.companyId,
      amountCents: input.amountCents,
      transactionId: txId,
    });
  }

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
     SET status = 'completed', ledger_entry_id = ?, stripe_event_id = ?, completed_at = ?
     WHERE id = ?`,
  )
    .bind(ledger.entry.id, input.stripeEventId, now, txId)
    .run();

  const monthKey = now.slice(0, 7);
  await env.DB.prepare(
    `UPDATE company_commercial_settings
     SET auto_top_up_month_key = ?,
         auto_top_up_monthly_spent_cents = CASE
           WHEN auto_top_up_month_key = ? THEN COALESCE(auto_top_up_monthly_spent_cents, 0) + ?
           ELSE ?
         END,
         updated_at = ?
     WHERE company_id = ?`,
  )
    .bind(monthKey, monthKey, input.amountCents, input.amountCents, now, input.companyId)
    .run();

  if (!ledger.alreadyExists) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "auto_topup.completed",
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
     WHERE id = ? AND status != 'completed'`,
  )
    .bind(input.failureReason, input.stripeEventId, nowIso(), tx.id)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "auto_topup.failed",
    actor: "stripe-webhook",
    resourceType: "auto_top_up_transaction",
    resourceId: String(tx.id),
    detail: { reason: input.failureReason },
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
