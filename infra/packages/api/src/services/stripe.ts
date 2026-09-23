import { newId, nowIso } from "../db/mappers";
import { appendLedgerEntry } from "./ledger";
import { recordAuditEvent } from "./control-plane";
import {
  DEFAULT_TOP_UP_OPTIONS_CENTS,
  LIVE_ACCEPTANCE_TOP_UP_CENTS,
  ensurePaymentProviderAccount,
} from "./payment-providers";
import type { Env } from "../env";
import {
  companyCanReceiveLiveWalletCredit,
  companyStripeCheckoutAllowed,
  getCompanyBillingMode,
} from "./company-billing-mode";

export type StripeMode = "unconfigured" | "test" | "live";

export type TopUpCheckoutStatus =
  | "created"
  | "checkout_created"
  | "pending"
  | "paid"
  | "credited"
  | "failed"
  | "expired"
  | "partially_refunded"
  | "refunded";

/** Production commercial live mode — operator approved 2026-08-28 for Caddington £1 acceptance. */
export const STRIPE_LIVE_MODE_ALLOWED = true;

const WEBHOOK_TOLERANCE_SECONDS = 300;

export function isStripeConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && stripeWebhookSecrets(env).length > 0);
}

/** Legacy + canonical webhook signing secrets. Empty values are ignored. */
export function stripeWebhookSecrets(env: Env): string[] {
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_INFRASTACK]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return [...new Set(secrets)];
}

export function getStripeMode(env: Env): StripeMode {
  if (!env.STRIPE_SECRET_KEY) return "unconfigured";
  return env.STRIPE_SECRET_KEY.startsWith("sk_test_") ? "test" : "live";
}

export function isStripeTestModeActive(env: Env): boolean {
  return getStripeMode(env) === "test";
}

export function stripePaymentsAllowed(env: Env): boolean {
  if (!isStripeConfigured(env)) return false;
  const mode = getStripeMode(env);
  if (mode === "test") return true;
  return mode === "live" && STRIPE_LIVE_MODE_ALLOWED;
}

export function minimumTopUpAmountCents(
  env: Env,
  companyBillingMode: Awaited<ReturnType<typeof getCompanyBillingMode>>,
): number {
  if (isAllowedTopUpAmountCents(LIVE_ACCEPTANCE_TOP_UP_CENTS, env, companyBillingMode)) {
    return LIVE_ACCEPTANCE_TOP_UP_CENTS;
  }
  return 500;
}

export function isAllowedTopUpAmountCents(
  amountCents: number,
  env?: Env,
  companyBillingMode?: Awaited<ReturnType<typeof getCompanyBillingMode>>,
): boolean {
  const allowed = new Set<number>(DEFAULT_TOP_UP_OPTIONS_CENTS);
  if (env && isStripeTestModeActive(env)) {
    allowed.add(LIVE_ACCEPTANCE_TOP_UP_CENTS);
  }
  if (
    env &&
    getStripeMode(env) === "live" &&
    STRIPE_LIVE_MODE_ALLOWED &&
    companyBillingMode === "live"
  ) {
    allowed.add(LIVE_ACCEPTANCE_TOP_UP_CENTS);
  }
  return allowed.has(amountCents);
}

type CheckoutRow = Record<string, unknown>;

function parseCheckoutRow(row: CheckoutRow) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    stripeSessionId: row.stripe_session_id ? String(row.stripe_session_id) : null,
    stripePaymentIntentId: row.stripe_payment_intent_id
      ? String(row.stripe_payment_intent_id)
      : null,
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    amountCents: Number(row.amount_cents),
    currency: String(row.currency ?? "GBP"),
    status: String(row.status) as TopUpCheckoutStatus,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    creditedAt: row.credited_at ? String(row.credited_at) : null,
    stripeMode: row.stripe_mode ? String(row.stripe_mode) : null,
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
  };
}

async function getCheckoutById(db: D1Database, checkoutId: string, companyId?: string) {
  const row = companyId
    ? await db
        .prepare(`SELECT * FROM stripe_checkout_sessions WHERE id = ? AND company_id = ?`)
        .bind(checkoutId, companyId)
        .first()
    : await db
        .prepare(`SELECT * FROM stripe_checkout_sessions WHERE id = ?`)
        .bind(checkoutId)
        .first();
  return row ? parseCheckoutRow(row as CheckoutRow) : null;
}

async function getCheckoutByPaymentIntent(db: D1Database, paymentIntentId: string) {
  const row = await db
    .prepare(`SELECT * FROM stripe_checkout_sessions WHERE stripe_payment_intent_id = ?`)
    .bind(paymentIntentId)
    .first();
  return row ? parseCheckoutRow(row as CheckoutRow) : null;
}

async function getCompanyRecord(db: D1Database, companyId: string) {
  return db
    .prepare(`SELECT id, name, status, archived_at FROM companies WHERE id = ?`)
    .bind(companyId)
    .first();
}

async function stripeCustomerExists(env: Env, customerId: string): Promise<boolean> {
  const response = await fetch(
    `https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`,
    {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    },
  );
  return response.ok;
}

async function archiveStripeCustomerReference(
  env: Env,
  companyId: string,
  customerId: string,
  archivedMode: StripeMode,
): Promise<void> {
  await ensurePaymentProviderAccount(env.DB, companyId, "stripe");
  const providerRow = await env.DB.prepare(
    `SELECT metadata_json FROM payment_provider_accounts WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(companyId)
    .first();
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(providerRow?.metadata_json ?? "{}")) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  const archived = Array.isArray(metadata.archivedStripeCustomers)
    ? [...metadata.archivedStripeCustomers]
    : [];
  archived.push({ id: customerId, mode: archivedMode, archivedAt: nowIso() });
  metadata.archivedStripeCustomers = archived;
  metadata.activeStripeMode = getStripeMode(env);
  await env.DB.prepare(
    `UPDATE payment_provider_accounts
     SET metadata_json = ?, external_customer_ref = NULL, updated_at = ?
     WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(JSON.stringify(metadata), nowIso(), companyId)
    .run();
  await env.DB.prepare(
    `UPDATE credit_balances
     SET stripe_customer_id = NULL, updated_at = ?
     WHERE company_id = ? AND stripe_customer_id = ?`,
  )
    .bind(nowIso(), companyId, customerId)
    .run();
}

/** Reusable Stripe Customer — one per INFRA company, stored in credit_balances + payment_provider_accounts. */
export async function ensureStripeCustomer(
  env: Env,
  input: { companyId: string; companyName: string; actorEmail: string },
): Promise<{ ok: true; customerId: string } | { ok: false; error: string }> {
  const companyBillingMode = await getCompanyBillingMode(env.DB, input.companyId);
  const checkoutGate = companyStripeCheckoutAllowed(env, companyBillingMode);
  if (!checkoutGate.allowed) {
    return { ok: false, error: checkoutGate.reason ?? "Stripe payments are not enabled" };
  }

  const balanceRow = await env.DB.prepare(
    `SELECT stripe_customer_id FROM credit_balances WHERE company_id = ?`,
  )
    .bind(input.companyId)
    .first();

  const providerRow = await env.DB.prepare(
    `SELECT external_customer_ref FROM payment_provider_accounts
     WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(input.companyId)
    .first();

  const existing =
    (balanceRow?.stripe_customer_id ? String(balanceRow.stripe_customer_id) : null) ??
    (providerRow?.external_customer_ref ? String(providerRow.external_customer_ref) : null);

  if (existing) {
    const validInCurrentMode = await stripeCustomerExists(env, existing);
    if (!validInCurrentMode) {
      const archivedMode: StripeMode = getStripeMode(env) === "live" ? "test" : "live";
      await archiveStripeCustomerReference(env, input.companyId, existing, archivedMode);
    } else {
      await ensurePaymentProviderAccount(env.DB, input.companyId, "stripe");
      await env.DB.prepare(
        `UPDATE payment_provider_accounts
         SET external_customer_ref = COALESCE(external_customer_ref, ?), status = 'ready', updated_at = ?
         WHERE company_id = ? AND provider = 'stripe'`,
      )
        .bind(existing, nowIso(), input.companyId)
        .run();
      return { ok: true, customerId: existing };
    }
  }

  const params = new URLSearchParams();
  params.set("name", input.companyName);
  params.set("metadata[company_id]", input.companyId);
  params.set("metadata[infra_company_id]", input.companyId);
  if (input.actorEmail) params.set("email", input.actorEmail);

  const response = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const body = (await response.json()) as { id?: string; error?: { message?: string } };
  if (!response.ok || !body.id) {
    return { ok: false, error: body.error?.message ?? "Unable to create Stripe customer" };
  }

  const now = nowIso();
  await env.DB.prepare(
    `UPDATE credit_balances SET stripe_customer_id = ?, updated_at = ? WHERE company_id = ?`,
  )
    .bind(body.id, now, input.companyId)
    .run();

  await ensurePaymentProviderAccount(env.DB, input.companyId, "stripe");
  const providerMetaRow = await env.DB.prepare(
    `SELECT metadata_json FROM payment_provider_accounts WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(input.companyId)
    .first();
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(providerMetaRow?.metadata_json ?? "{}")) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  metadata.activeStripeMode = getStripeMode(env);
  metadata.liveCustomerCreatedAt = now;
  await env.DB.prepare(
    `UPDATE payment_provider_accounts
     SET external_customer_ref = ?, status = 'ready', updated_at = ?, metadata_json = ?
     WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(body.id, now, JSON.stringify(metadata), input.companyId)
    .run();

  return { ok: true, customerId: body.id };
}

export async function createTopUpCheckoutIntent(
  env: Env,
  input: {
    companyId: string;
    companyName: string;
    amountCents: number;
    createdBy: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<
  | { configured: false; error: string; code?: string }
  | {
      configured: true;
      checkoutSessionId: string;
      url: string | null;
      localId: string;
      mode: "live_api" | "pending_credentials";
      stripeMode: StripeMode;
    }
> {
  const company = await getCompanyRecord(env.DB, input.companyId);
  if (!company) {
    return { configured: false, error: "Company not found", code: "COMPANY_NOT_FOUND" };
  }
  if (String(company.status) === "suspended") {
    return { configured: false, error: "Company is suspended", code: "COMPANY_SUSPENDED" };
  }
  if (company.archived_at) {
    return { configured: false, error: "Company is archived", code: "COMPANY_ARCHIVED" };
  }

  const companyBillingMode = await getCompanyBillingMode(env.DB, input.companyId);
  if (!isAllowedTopUpAmountCents(input.amountCents, env, companyBillingMode)) {
    return {
      configured: false,
      error: isStripeTestModeActive(env)
        ? "Invalid top-up amount. Allowed: £1 (sandbox), £5, £10, £25, £50, £100."
        : companyBillingMode === "live"
          ? "Invalid top-up amount. Allowed: £1 (live acceptance), £5, £10, £25, £50, £100."
          : "Invalid top-up amount. Allowed: £5, £10, £25, £50, £100.",
      code: "INVALID_AMOUNT",
    };
  }
  const checkoutGate = companyStripeCheckoutAllowed(env, companyBillingMode);
  if (!checkoutGate.allowed) {
    return {
      configured: false,
      error: checkoutGate.reason ?? "Stripe checkout is not allowed for this company",
      code: "BILLING_MODE_BLOCKED",
    };
  }

  const localId = newId("stripe_co");
  const createdAt = nowIso();
  const stripeMode = getStripeMode(env);
  const successUrl = input.successUrl.includes("checkout=")
    ? input.successUrl
    : `${input.successUrl}${input.successUrl.includes("?") ? "&" : "?"}checkout=${localId}`;

  await env.DB.prepare(
    `INSERT INTO stripe_checkout_sessions (
      id, company_id, stripe_session_id, amount_cents, currency, status,
      created_by, created_at, completed_at, metadata_json, stripe_mode
    ) VALUES (?, ?, NULL, ?, 'GBP', 'created', ?, ?, NULL, ?, ?)`,
  )
    .bind(
      localId,
      input.companyId,
      input.amountCents,
      input.createdBy,
      createdAt,
      JSON.stringify({ successUrl, cancelUrl: input.cancelUrl }),
      stripeMode === "unconfigured" ? null : stripeMode,
    )
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "topup.requested",
    actor: input.createdBy,
    resourceType: "stripe_checkout",
    resourceId: localId,
    detail: { amountCents: input.amountCents, currency: "GBP" },
  });

  if (!isStripeConfigured(env)) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "checkout.created",
      actor: input.createdBy,
      resourceType: "stripe_checkout",
      resourceId: localId,
      detail: {
        status: "pending_credentials",
        amountCents: input.amountCents,
        message: "Stripe secrets not configured",
      },
    });

    return {
      configured: true,
      checkoutSessionId: localId,
      url: null,
      localId,
      mode: "pending_credentials",
      stripeMode,
    };
  }

  if (!checkoutGate.allowed) {
    await env.DB.prepare(
      `UPDATE stripe_checkout_sessions SET status = 'failed', failure_reason = ? WHERE id = ?`,
    )
      .bind(checkoutGate.reason ?? "Checkout not allowed", localId)
      .run();
    return {
      configured: false,
      error: checkoutGate.reason ?? "Checkout not allowed",
      code: "BILLING_MODE_BLOCKED",
    };
  }

  const customer = await ensureStripeCustomer(env, {
    companyId: input.companyId,
    companyName: input.companyName,
    actorEmail: input.createdBy,
  });
  if (!customer.ok) {
    await env.DB.prepare(
      `UPDATE stripe_checkout_sessions SET status = 'failed', failure_reason = ? WHERE id = ?`,
    )
      .bind(customer.error, localId)
      .run();
    return { configured: false, error: customer.error, code: "STRIPE_CUSTOMER_FAILED" };
  }

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", successUrl);
  params.set("cancel_url", input.cancelUrl);
  params.set("client_reference_id", localId);
  params.set("customer", customer.customerId);
  params.set("metadata[company_id]", input.companyId);
  params.set("metadata[infra_checkout_id]", localId);
  params.set("metadata[infra_company_id]", input.companyId);
  params.set("metadata[amount_cents]", String(input.amountCents));
  params.set("metadata[currency]", "GBP");
  params.set("metadata[initiated_by]", input.createdBy);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "gbp");
  params.set("line_items[0][price_data][unit_amount]", String(input.amountCents));
  params.set("line_items[0][price_data][product_data][name]", "INFRA prepaid credit");

  if (stripeMode === "live" && companyBillingMode === "live") {
    params.set("payment_intent_data[setup_future_usage]", "off_session");
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const body = (await response.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };

  if (!response.ok || !body.id) {
    await env.DB.prepare(
      `UPDATE stripe_checkout_sessions SET status = 'failed', failure_reason = ? WHERE id = ?`,
    )
      .bind(body.error?.message ?? "Stripe checkout session failed", localId)
      .run();
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "payment.failed",
      actor: input.createdBy,
      resourceType: "stripe_checkout",
      resourceId: localId,
      detail: { reason: body.error?.message ?? "checkout_create_failed" },
    });
    return {
      configured: false,
      error: body.error?.message ?? "Stripe checkout session failed",
      code: "CHECKOUT_CREATE_FAILED",
    };
  }

  await env.DB.prepare(
    `UPDATE stripe_checkout_sessions
     SET stripe_session_id = ?, stripe_customer_id = ?, status = 'checkout_created'
     WHERE id = ?`,
  )
    .bind(body.id, customer.customerId, localId)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "checkout.created",
    actor: input.createdBy,
    resourceType: "stripe_checkout",
    resourceId: localId,
    detail: {
      stripeSessionId: body.id,
      amountCents: input.amountCents,
      stripeCustomerId: customer.customerId,
      stripeMode: getStripeMode(env),
    },
  });

  return {
    configured: true,
    checkoutSessionId: body.id,
    url: body.url ?? null,
    localId,
    mode: "live_api",
    stripeMode: getStripeMode(env),
  };
}

export async function getTopUpCheckoutStatus(
  env: Env,
  companyId: string,
  checkoutId: string,
) {
  const checkout = await getCheckoutById(env.DB, checkoutId, companyId);
  if (!checkout) return null;

  const ledgerCredited = await env.DB.prepare(
    `SELECT id FROM ledger_entries
     WHERE company_id = ? AND reference_type = 'stripe_checkout' AND reference_id = ?`,
  )
    .bind(companyId, checkoutId)
    .first();

  return {
    ...checkout,
    ledgerCredited: Boolean(ledgerCredited),
    awaitingWebhook:
      checkout.status === "checkout_created" ||
      checkout.status === "pending" ||
      checkout.status === "paid",
  };
}

export async function listRecentTopUps(db: D1Database, companyId: string, limit = 10) {
  const rows = await db
    .prepare(
      `SELECT * FROM stripe_checkout_sessions
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(companyId, limit)
    .all();
  return (rows.results ?? []).map((row) => parseCheckoutRow(row as CheckoutRow));
}

async function getRefundedTotalForCheckout(db: D1Database, checkoutId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(ABS(amount_cents)), 0) AS total
       FROM ledger_entries
       WHERE entry_type = 'refund'
         AND reference_type = 'stripe_refund'
         AND json_extract(metadata_json, '$.checkoutId') = ?`,
    )
    .bind(checkoutId)
    .first();
  return Number(row?.total ?? 0);
}

type WebhookProcessResult = {
  processed: boolean;
  duplicate: boolean;
  message: string;
  code?: string;
};

function sessionObject(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data as { object?: Record<string, unknown> } | undefined;
  return data?.object ?? {};
}

function metadataString(object: Record<string, unknown>, key: string): string | null {
  const meta = object.metadata as Record<string, string> | undefined;
  return meta?.[key] ? String(meta[key]) : null;
}

async function markWebhookProcessed(
  db: D1Database,
  stripeEventId: string,
  errorMessage?: string | null,
) {
  await db
    .prepare(
      `UPDATE stripe_webhook_events
       SET processed = 1, processed_at = ?, error_message = COALESCE(?, error_message)
       WHERE stripe_event_id = ?`,
    )
    .bind(nowIso(), errorMessage ?? null, stripeEventId)
    .run();
}

async function creditCheckoutFromWebhook(
  env: Env,
  input: {
    stripeEventId: string;
    checkout: ReturnType<typeof parseCheckoutRow>;
    stripeSessionId: string;
    stripePaymentIntentId: string | null;
    actor?: string;
  },
): Promise<WebhookProcessResult> {
  if (input.checkout.status === "credited") {
    await markWebhookProcessed(env.DB, input.stripeEventId);
    return { processed: false, duplicate: true, message: "Checkout already credited" };
  }

  const companyBillingMode = await getCompanyBillingMode(env.DB, input.checkout.companyId);
  const sessionStripeMode = input.checkout.stripeMode ?? getStripeMode(env);
  if (
    sessionStripeMode === "live" &&
    !companyCanReceiveLiveWalletCredit(companyBillingMode)
  ) {
    const message =
      "Live Stripe checkout cannot credit a company with billing_mode=test — webhook credit blocked";
    await env.DB.prepare(
      `UPDATE stripe_checkout_sessions SET status = 'failed', failure_reason = ? WHERE id = ? AND company_id = ?`,
    )
      .bind(message, input.checkout.id, input.checkout.companyId)
      .run();
    await markWebhookProcessed(env.DB, input.stripeEventId, message);
    return { processed: false, duplicate: false, message };
  }

  const companyId = input.checkout.companyId;
  const amountCents = input.checkout.amountCents;
  const now = nowIso();
  const creditClass =
    sessionStripeMode === "live" && companyCanReceiveLiveWalletCredit(companyBillingMode)
      ? "paid"
      : "test";

  await env.DB.prepare(
    `UPDATE stripe_checkout_sessions SET status = 'paid' WHERE id = ? AND company_id = ?`,
  )
    .bind(input.checkout.id, companyId)
    .run();

  const ledger = await appendLedgerEntry(env.DB, {
    companyId,
    entryType: "top_up",
    amountCents,
    referenceType: "stripe_checkout",
    referenceId: input.checkout.id,
    description: `Stripe top-up £${(amountCents / 100).toFixed(2)}`,
    metadata: {
      creditClass,
      stripeSessionId: input.stripeSessionId,
      stripeEventId: input.stripeEventId,
      stripePaymentIntentId: input.stripePaymentIntentId,
      stripeMode: input.checkout.stripeMode,
    },
    createdBy: input.actor ?? "stripe-webhook",
  });

  await env.DB.prepare(
    `UPDATE stripe_checkout_sessions
     SET status = 'credited', completed_at = ?, credited_at = ?,
         stripe_session_id = COALESCE(stripe_session_id, ?),
         stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id)
     WHERE id = ? AND company_id = ?`,
  )
    .bind(
      now,
      now,
      input.stripeSessionId || null,
      input.stripePaymentIntentId,
      input.checkout.id,
      companyId,
    )
    .run();

  await recordAuditEvent(env.DB, {
    companyId,
    eventType: "payment.confirmed",
    actor: "stripe-webhook",
    resourceType: "stripe_checkout",
    resourceId: input.checkout.id,
    detail: {
      amountCents,
      stripeSessionId: input.stripeSessionId,
      stripeEventId: input.stripeEventId,
    },
  });

  if (!ledger.alreadyExists) {
    await recordAuditEvent(env.DB, {
      companyId,
      eventType: "wallet.credited",
      actor: "stripe-webhook",
      resourceType: "ledger",
      resourceId: ledger.entry.id,
      detail: { amountCents, entryType: "top_up", creditClass },
    });
  }

  if (input.stripePaymentIntentId && creditClass === "paid") {
    const sync = await syncDefaultPaymentMethodForCompany(env, companyId, {
      paymentIntentId: input.stripePaymentIntentId,
    });
    if (!sync.ok) {
      await recordAuditEvent(env.DB, {
        companyId,
        eventType: "payment_method.sync_deferred",
        actor: "stripe-webhook",
        resourceType: "stripe_checkout",
        resourceId: input.checkout.id,
        detail: { reason: sync.error, paymentIntentId: input.stripePaymentIntentId },
      });
    }
  }

  return {
    processed: true,
    duplicate: ledger.alreadyExists,
    message: ledger.alreadyExists ? "Already credited" : "credited",
  };
}

/** Idempotent webhook processing — credits ledger once per Stripe event + checkout. */
export async function processStripeWebhookEvent(
  env: Env,
  input: {
    stripeEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<WebhookProcessResult> {
  if (!stripePaymentsAllowed(env)) {
    return { processed: false, duplicate: false, message: "Stripe payments not allowed", code: "PAYMENTS_BLOCKED" };
  }

  const existing = await env.DB.prepare(
    `SELECT * FROM stripe_webhook_events WHERE stripe_event_id = ?`,
  )
    .bind(input.stripeEventId)
    .first();

  if (existing && Number(existing.processed) === 1) {
    return { processed: false, duplicate: true, message: "Event already processed" };
  }

  const receivedAt = nowIso();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO stripe_webhook_events (
        id, stripe_event_id, event_type, processed, payload_json, received_at, processed_at
      ) VALUES (?, ?, ?, 0, ?, ?, NULL)`,
    )
      .bind(
        newId("stripe_evt"),
        input.stripeEventId,
        input.eventType,
        JSON.stringify({ type: input.eventType }),
        receivedAt,
      )
      .run();
  }

  try {
    if (input.eventType === "checkout.session.completed") {
      const object = sessionObject(input.payload);
      const mode = String(object.mode ?? "payment");

      if (mode === "setup") {
        const result = await handleSetupCheckoutCompleted(env, {
          stripeEventId: input.stripeEventId,
          object,
        });
        await markWebhookProcessed(env.DB, input.stripeEventId);
        return result;
      }

      const paymentStatus = String(object.payment_status ?? "");
      if (paymentStatus !== "paid") {
        await markWebhookProcessed(env.DB, input.stripeEventId, "Payment not completed");
        return { processed: false, duplicate: false, message: "Payment not completed", code: "NOT_PAID" };
      }

      const stripeSessionId = String(object.id ?? "");
      const localId = String(
        metadataString(object, "infra_checkout_id") ??
          object.client_reference_id ??
          "",
      );
      const metadataCompanyId = metadataString(object, "company_id") ?? metadataString(object, "infra_company_id");
      const stripePaymentIntentId = object.payment_intent ? String(object.payment_intent) : null;

      const amountTotal = object.amount_total != null ? Number(object.amount_total) : null;
      const currency = object.currency ? String(object.currency).toUpperCase() : null;

      const checkout = localId
        ? await getCheckoutById(env.DB, localId)
        : await env.DB
            .prepare(`SELECT * FROM stripe_checkout_sessions WHERE stripe_session_id = ?`)
            .bind(stripeSessionId)
            .first()
            .then((row) => (row ? parseCheckoutRow(row as CheckoutRow) : null));

      if (!checkout) {
        await markWebhookProcessed(env.DB, input.stripeEventId, "Checkout session not found");
        return { processed: false, duplicate: false, message: "Checkout session not found", code: "UNKNOWN_CHECKOUT" };
      }

      if (metadataCompanyId && metadataCompanyId !== checkout.companyId) {
        await markWebhookProcessed(env.DB, input.stripeEventId, "Company mismatch");
        return { processed: false, duplicate: false, message: "Company mismatch", code: "COMPANY_MISMATCH" };
      }

      if (amountTotal != null && amountTotal !== checkout.amountCents) {
        await markWebhookProcessed(env.DB, input.stripeEventId, "Amount mismatch");
        return { processed: false, duplicate: false, message: "Amount mismatch", code: "AMOUNT_MISMATCH" };
      }

      if (currency && currency !== checkout.currency.toUpperCase()) {
        await markWebhookProcessed(env.DB, input.stripeEventId, "Currency mismatch");
        return { processed: false, duplicate: false, message: "Currency mismatch", code: "CURRENCY_MISMATCH" };
      }

      const result = await creditCheckoutFromWebhook(env, {
        stripeEventId: input.stripeEventId,
        checkout,
        stripeSessionId,
        stripePaymentIntentId,
      });
      await markWebhookProcessed(env.DB, input.stripeEventId);
      return result;
    }

    if (input.eventType === "checkout.session.expired") {
      const object = sessionObject(input.payload);
      const localId = String(
        metadataString(object, "infra_checkout_id") ?? object.client_reference_id ?? "",
      );
      if (localId) {
        const checkout = await getCheckoutById(env.DB, localId);
        await env.DB.prepare(
          `UPDATE stripe_checkout_sessions SET status = 'expired' WHERE id = ? AND status != 'credited'`,
        )
          .bind(localId)
          .run();
        if (checkout && checkout.status !== "credited") {
          await recordAuditEvent(env.DB, {
            companyId: checkout.companyId,
            eventType: "checkout.expired",
            actor: "stripe-webhook",
            resourceType: "stripe_checkout",
            resourceId: localId,
            detail: { stripeEventId: input.stripeEventId },
          });
        }
      }
      await markWebhookProcessed(env.DB, input.stripeEventId);
      return { processed: true, duplicate: false, message: "checkout expired" };
    }

    /**
     * Admin-only refunds: customers cannot initiate refunds via INFRA.
     * An authorised administrator issues the refund in Stripe Dashboard (or Stripe API
     * outside INFRA). This handler reconciles charge.refunded webhooks into ledger rows.
     */
    if (input.eventType === "charge.refunded") {
      const object = sessionObject(input.payload);
      const paymentIntentId = object.payment_intent ? String(object.payment_intent) : null;
      if (!paymentIntentId) {
        await markWebhookProcessed(env.DB, input.stripeEventId, "Missing payment_intent");
        return { processed: false, duplicate: false, message: "Missing payment_intent", code: "MISSING_PI" };
      }

      const checkout = await getCheckoutByPaymentIntent(env.DB, paymentIntentId);
      if (!checkout) {
        await markWebhookProcessed(env.DB, input.stripeEventId, "Checkout not found for refund");
        return { processed: false, duplicate: false, message: "Checkout not found for refund", code: "UNKNOWN_REFUND" };
      }

      const amountRefundedCumulative = Number(object.amount_refunded ?? 0);
      if (amountRefundedCumulative <= 0) {
        await markWebhookProcessed(env.DB, input.stripeEventId);
        return { processed: true, duplicate: false, message: "No refund amount" };
      }

      const alreadyRefunded = await getRefundedTotalForCheckout(env.DB, checkout.id);
      const incrementalRefund = amountRefundedCumulative - alreadyRefunded;
      if (incrementalRefund <= 0) {
        await markWebhookProcessed(env.DB, input.stripeEventId);
        return { processed: false, duplicate: true, message: "Refund already recorded" };
      }

      const chargeId = object.id ? String(object.id) : null;
      const ledger = await appendLedgerEntry(env.DB, {
        companyId: checkout.companyId,
        entryType: "refund",
        amountCents: -incrementalRefund,
        referenceType: "stripe_refund",
        referenceId: input.stripeEventId,
        description: `Stripe refund £${(incrementalRefund / 100).toFixed(2)}`,
        metadata: {
          creditClass: "paid",
          stripeEventId: input.stripeEventId,
          stripePaymentIntentId: paymentIntentId,
          stripeChargeId: chargeId,
          checkoutId: checkout.id,
          cumulativeRefundedCents: amountRefundedCumulative,
          incrementalRefundedCents: incrementalRefund,
        },
        createdBy: "stripe-webhook",
      });

      const nextStatus =
        amountRefundedCumulative >= checkout.amountCents ? "refunded" : "partially_refunded";
      await env.DB.prepare(
        `UPDATE stripe_checkout_sessions SET status = ? WHERE id = ?`,
      )
        .bind(nextStatus, checkout.id)
        .run();

      if (!ledger.alreadyExists) {
        await recordAuditEvent(env.DB, {
          companyId: checkout.companyId,
          eventType: "refund.received",
          actor: "stripe-webhook",
          resourceType: "stripe_checkout",
          resourceId: checkout.id,
          detail: {
            incrementalRefunded: incrementalRefund,
            cumulativeRefunded: amountRefundedCumulative,
            ledgerEntryId: ledger.entry.id,
            walletMayGoNegative:
              "Refunds reduce paid wallet balance; negative balance is permitted when credit was already consumed.",
          },
        });
        await recordAuditEvent(env.DB, {
          companyId: checkout.companyId,
          eventType: "wallet.adjusted",
          actor: "stripe-webhook",
          resourceType: "ledger",
          resourceId: ledger.entry.id,
          detail: {
            amountCents: -incrementalRefund,
            entryType: "refund",
            creditClass: "paid",
            reason: "stripe_refund",
          },
        });
      }

      await markWebhookProcessed(env.DB, input.stripeEventId);
      return { processed: true, duplicate: false, message: "refund recorded" };
    }

    if (input.eventType === "payment_intent.succeeded") {
      const object = sessionObject(input.payload);
      const metadata = (object.metadata ?? {}) as Record<string, string>;
      const companyId =
        metadata.company_id ?? metadata.infra_company_id ?? metadata.infra_company_id;
      const source = metadata.source ?? "";
      const amountCents = Number(object.amount_received ?? object.amount ?? 0);
      const paymentIntentId = String(object.id ?? "");

      if (companyId && source === "auto_top_up" && amountCents > 0) {
        const { creditAutoTopUpFromPaymentIntent } = await import("./auto-topup");
        const result = await creditAutoTopUpFromPaymentIntent(env, {
          stripeEventId: input.stripeEventId,
          paymentIntentId,
          companyId,
          amountCents,
          transactionId: metadata.auto_top_up_transaction_id,
        });
        await markWebhookProcessed(env.DB, input.stripeEventId);
        return {
          processed: true,
          duplicate: result.duplicate,
          message: result.credited ? "auto top-up credited" : "already credited",
        };
      }

      await markWebhookProcessed(env.DB, input.stripeEventId);
      return { processed: true, duplicate: false, message: "payment_intent ignored" };
    }

    if (input.eventType === "payment_intent.payment_failed") {
      const object = sessionObject(input.payload);
      const metadata = (object.metadata ?? {}) as Record<string, string>;
      const companyId = metadata.company_id ?? metadata.infra_company_id;
      const source = metadata.source ?? "";
      const paymentIntentId = String(object.id ?? "");
      const failureMessage =
        (object.last_payment_error as { message?: string } | undefined)?.message ??
        "Payment failed";

      if (companyId && source === "auto_top_up") {
        const { failAutoTopUpFromPaymentIntent } = await import("./auto-topup");
        await failAutoTopUpFromPaymentIntent(env, {
          paymentIntentId,
          companyId,
          failureReason: failureMessage,
          stripeEventId: input.stripeEventId,
        });
      }

      await markWebhookProcessed(env.DB, input.stripeEventId);
      return { processed: true, duplicate: false, message: "payment failure recorded" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markWebhookProcessed(env.DB, input.stripeEventId, message);
    return { processed: false, duplicate: false, message, code: "PROCESSING_ERROR" };
  }

  await markWebhookProcessed(env.DB, input.stripeEventId);
  return { processed: true, duplicate: false, message: "ignored event type" };
}

/** Verify Stripe webhook signature (v1) with replay tolerance. */
export async function verifyStripeWebhookSignature(
  env: Env,
  payload: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secrets = stripeWebhookSecrets(env);
  if (secrets.length === 0 || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [k, v] = part.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const signedPayload = `${timestamp}.${payload}`;
  for (const secret of secrets) {
    if (await stripeSignatureMatches(secret, signedPayload, signature)) {
      return true;
    }
  }
  return false;
}

async function stripeSignatureMatches(
  secret: string,
  signedPayload: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

export type StripePaymentMethodSummary = {
  configured: boolean;
  hasPaymentMethod: boolean;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  setupRequired: boolean;
  message: string;
};

type ResolvedStripePaymentMethod = {
  paymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

async function stripeApiRequest(
  env: Env,
  path: string,
  init?: { method?: string; body?: URLSearchParams },
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.body?.toString(),
  });
  const data = (await response.json()) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

function resolvedFromPaymentMethodObject(
  paymentMethod: Record<string, unknown>,
): ResolvedStripePaymentMethod | null {
  const id = paymentMethod.id ? String(paymentMethod.id) : null;
  if (!id) return null;
  const card = (paymentMethod.card ?? {}) as Record<string, unknown>;
  return {
    paymentMethodId: id,
    brand: card.brand ? String(card.brand) : null,
    last4: card.last4 ? String(card.last4) : null,
    expMonth: card.exp_month != null ? Number(card.exp_month) : null,
    expYear: card.exp_year != null ? Number(card.exp_year) : null,
  };
}

async function fetchPaymentMethodById(
  env: Env,
  paymentMethodId: string,
): Promise<ResolvedStripePaymentMethod | null> {
  const response = await stripeApiRequest(env, `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`);
  if (!response.ok) return null;
  return resolvedFromPaymentMethodObject(response.data);
}

async function resolveCustomerPaymentMethod(
  env: Env,
  input: {
    customerId: string;
    paymentIntentId?: string | null;
    setupIntentId?: string | null;
  },
): Promise<ResolvedStripePaymentMethod | null> {
  if (input.setupIntentId) {
    const setup = await stripeApiRequest(
      env,
      `/v1/setup_intents/${encodeURIComponent(input.setupIntentId)}?expand[]=payment_method`,
    );
    if (setup.ok) {
      const pm = setup.data.payment_method;
      if (pm && typeof pm === "object") {
        const resolved = resolvedFromPaymentMethodObject(pm as Record<string, unknown>);
        if (resolved) return resolved;
      }
      if (typeof pm === "string") {
        const byId = await fetchPaymentMethodById(env, pm);
        if (byId) return byId;
      }
    }
  }

  if (input.paymentIntentId) {
    const intent = await stripeApiRequest(
      env,
      `/v1/payment_intents/${encodeURIComponent(input.paymentIntentId)}?expand[]=payment_method`,
    );
    if (intent.ok) {
      const pm = intent.data.payment_method;
      if (pm && typeof pm === "object") {
        const resolved = resolvedFromPaymentMethodObject(pm as Record<string, unknown>);
        if (resolved) return resolved;
      }
      if (typeof pm === "string") {
        const byId = await fetchPaymentMethodById(env, pm);
        if (byId) return byId;
      }
    }
  }

  const customer = await stripeApiRequest(
    env,
    `/v1/customers/${encodeURIComponent(input.customerId)}?expand[]=invoice_settings.default_payment_method`,
  );
  if (customer.ok) {
    const defaultPm = customer.data.invoice_settings as
      | { default_payment_method?: Record<string, unknown> | string | null }
      | undefined;
    const pmRef = defaultPm?.default_payment_method;
    if (pmRef && typeof pmRef === "object") {
      const resolved = resolvedFromPaymentMethodObject(pmRef);
      if (resolved) return resolved;
    }
    if (typeof pmRef === "string") {
      const byId = await fetchPaymentMethodById(env, pmRef);
      if (byId) return byId;
    }
  }

  const listed = await stripeApiRequest(
    env,
    `/v1/customers/${encodeURIComponent(input.customerId)}/payment_methods?type=card&limit=1`,
  );
  if (listed.ok) {
    const data = listed.data.data;
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
      const resolved = resolvedFromPaymentMethodObject(data[0] as Record<string, unknown>);
      if (resolved) return resolved;
    }
  }

  return null;
}

async function setCustomerDefaultPaymentMethod(
  env: Env,
  customerId: string,
  paymentMethodId: string,
): Promise<boolean> {
  const params = new URLSearchParams();
  params.set("invoice_settings[default_payment_method]", paymentMethodId);
  const response = await stripeApiRequest(env, `/v1/customers/${encodeURIComponent(customerId)}`, {
    method: "POST",
    body: params,
  });
  return response.ok;
}

/** Read saved payment method summary from Stripe Customer (never returns full PAN). */
export async function getStripePaymentMethodStatus(
  env: Env,
  input: { companyId: string; companyName: string; actorEmail: string },
): Promise<StripePaymentMethodSummary> {
  if (!stripePaymentsAllowed(env)) {
    return {
      configured: false,
      hasPaymentMethod: false,
      brand: null,
      last4: null,
      expMonth: null,
      expYear: null,
      setupRequired: true,
      message: "Stripe payments are not configured",
    };
  }

  const customer = await ensureStripeCustomer(env, input);
  if (!customer.ok) {
    return {
      configured: false,
      hasPaymentMethod: false,
      brand: null,
      last4: null,
      expMonth: null,
      expYear: null,
      setupRequired: true,
      message: customer.error,
    };
  }

  const resolved = await resolveCustomerPaymentMethod(env, { customerId: customer.customerId });
  if (!resolved) {
    return {
      configured: true,
      hasPaymentMethod: false,
      brand: null,
      last4: null,
      expMonth: null,
      expYear: null,
      setupRequired: true,
      message: "No payment method on file",
    };
  }

  return {
    configured: true,
    hasPaymentMethod: true,
    brand: resolved.brand,
    last4: resolved.last4,
    expMonth: resolved.expMonth,
    expYear: resolved.expYear,
    setupRequired: false,
    message: "Payment method saved",
  };
}

/**
 * Stripe is authoritative for card presence; D1 stores masked metadata only.
 * Self-heals payment_provider_accounts when Stripe has a default PM but D1 is empty/stale.
 */
export async function reconcilePaymentMethodFromStripe(
  env: Env,
  input: { companyId: string; companyName: string; actorEmail: string },
): Promise<StripePaymentMethodSummary> {
  const status = await getStripePaymentMethodStatus(env, input);
  if (status.hasPaymentMethod) {
    await syncDefaultPaymentMethodForCompany(env, input.companyId);
  }
  return status;
}

/** Create Stripe Checkout Session in setup mode — saves card without charging. */
export async function createStripePaymentMethodSetupSession(
  env: Env,
  input: {
    companyId: string;
    companyName: string;
    actorEmail: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<
  | { configured: true; url: string; sessionId: string; customerId: string; localSetupId: string }
  | { configured: false; error: string }
> {
  if (!stripePaymentsAllowed(env)) {
    return { configured: false, error: "Stripe payments are not enabled" };
  }

  const customer = await ensureStripeCustomer(env, input);
  if (!customer.ok) return { configured: false, error: customer.error };

  const params = new URLSearchParams();
  params.set("mode", "setup");
  params.set("customer", customer.customerId);
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  params.set("payment_method_types[]", "card");
  params.set("metadata[company_id]", input.companyId);
  params.set("metadata[infra_company_id]", input.companyId);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const body = (await response.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!response.ok || !body.url || !body.id) {
    return {
      configured: false,
      error: body.error?.message ?? "Unable to create payment method setup session",
    };
  }

  const localId = newId("stripe_setup");
  await env.DB.prepare(
    `INSERT INTO stripe_setup_sessions (
      id, company_id, stripe_session_id, status, created_by, created_at
    ) VALUES (?, ?, ?, 'checkout_created', ?, ?)`,
  )
    .bind(localId, input.companyId, body.id, input.actorEmail, nowIso())
    .run();

  return {
    configured: true,
    url: body.url,
    sessionId: body.id,
    customerId: customer.customerId,
    localSetupId: localId,
  };
}

/** Create Stripe SetupIntent for saving a card without charging (test mode supported). */
export async function createStripeSetupIntent(
  env: Env,
  input: {
    companyId: string;
    companyName: string;
    actorEmail: string;
    returnUrl: string;
  },
): Promise<
  | { configured: true; clientSecret: string; customerId: string }
  | { configured: false; error: string }
> {
  if (!stripePaymentsAllowed(env)) {
    return { configured: false, error: "Stripe payments are not enabled" };
  }

  const customer = await ensureStripeCustomer(env, input);
  if (!customer.ok) return { configured: false, error: customer.error };

  const params = new URLSearchParams();
  params.set("customer", customer.customerId);
  params.set("usage", "off_session");
  params.set("payment_method_types[]", "card");
  params.set("metadata[company_id]", input.companyId);
  params.set("metadata[infra_company_id]", input.companyId);

  const response = await fetch("https://api.stripe.com/v1/setup_intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const body = (await response.json()) as {
    client_secret?: string;
    error?: { message?: string };
  };
  if (!response.ok || !body.client_secret) {
    return {
      configured: false,
      error: body.error?.message ?? "Unable to create setup intent",
    };
  }

  return {
    configured: true,
    clientSecret: body.client_secret,
    customerId: customer.customerId,
  };
}

async function handleSetupCheckoutCompleted(
  env: Env,
  input: { stripeEventId: string; object: Record<string, unknown> },
): Promise<WebhookProcessResult> {
  const companyId =
    metadataString(input.object, "company_id") ?? metadataString(input.object, "infra_company_id");
  if (!companyId) {
    return { processed: false, duplicate: false, message: "Missing company_id", code: "UNKNOWN_SETUP" };
  }

  const stripeSessionId = String(input.object.id ?? "");
  const setupIntentId = input.object.setup_intent ? String(input.object.setup_intent) : null;

  await env.DB.prepare(
    `UPDATE stripe_setup_sessions SET status = 'completed', completed_at = ?, stripe_setup_intent_id = COALESCE(?, stripe_setup_intent_id)
     WHERE stripe_session_id = ? AND company_id = ?`,
  )
    .bind(nowIso(), setupIntentId, stripeSessionId, companyId)
    .run();

  const synced = await syncDefaultPaymentMethodForCompany(env, companyId, {
    setupIntentId,
  });
  if (!synced.ok) {
    await recordAuditEvent(env.DB, {
      companyId,
      eventType: "payment_method.failed",
      actor: "stripe-webhook",
      resourceType: "stripe_setup",
      resourceId: stripeSessionId,
      detail: { error: synced.error, stripeEventId: input.stripeEventId },
    });
    return { processed: false, duplicate: false, message: synced.error, code: "SYNC_FAILED" };
  }

  const eventType = synced.replaced ? "payment_method.replaced" : "payment_method.added";
  await recordAuditEvent(env.DB, {
    companyId,
    eventType,
    actor: "stripe-webhook",
    resourceType: "payment_provider",
    resourceId: companyId,
    detail: {
      brand: synced.brand,
      last4: synced.last4,
      stripeEventId: input.stripeEventId,
    },
  });

  return { processed: true, duplicate: false, message: "payment method saved" };
}

export async function syncDefaultPaymentMethodForCompany(
  env: Env,
  companyId: string,
  hints?: { paymentIntentId?: string | null; setupIntentId?: string | null },
): Promise<
  | { ok: true; brand: string | null; last4: string | null; replaced: boolean }
  | { ok: false; error: string }
> {
  const balanceRow = await env.DB.prepare(
    `SELECT stripe_customer_id FROM credit_balances WHERE company_id = ?`,
  )
    .bind(companyId)
    .first();
  const customerId = balanceRow?.stripe_customer_id
    ? String(balanceRow.stripe_customer_id)
    : null;
  if (!customerId) return { ok: false, error: "Stripe customer not found" };

  await ensurePaymentProviderAccount(env.DB, companyId, "stripe");
  await env.DB.prepare(
    `UPDATE payment_provider_accounts
     SET external_customer_ref = COALESCE(external_customer_ref, ?), updated_at = ?
     WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(customerId, nowIso(), companyId)
    .run();

  const existing = await env.DB.prepare(
    `SELECT payment_method_id FROM payment_provider_accounts WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(companyId)
    .first();
  const hadPrevious = Boolean(existing?.payment_method_id);

  const resolved = await resolveCustomerPaymentMethod(env, {
    customerId,
    paymentIntentId: hints?.paymentIntentId,
    setupIntentId: hints?.setupIntentId,
  });
  if (!resolved) {
    return { ok: false, error: "No payment method on file" };
  }

  await setCustomerDefaultPaymentMethod(env, customerId, resolved.paymentMethodId);

  await env.DB.prepare(
    `UPDATE payment_provider_accounts
     SET payment_method_id = ?, payment_method_brand = ?, payment_method_last4 = ?,
         payment_method_exp_month = ?, payment_method_exp_year = ?,
         payment_method_status = 'active', status = 'ready', updated_at = ?
     WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(
      resolved.paymentMethodId,
      resolved.brand,
      resolved.last4,
      resolved.expMonth,
      resolved.expYear,
      nowIso(),
      companyId,
    )
    .run();

  return {
    ok: true,
    brand: resolved.brand,
    last4: resolved.last4,
    replaced: hadPrevious,
  };
}

export async function detachStripePaymentMethod(
  env: Env,
  input: { companyId: string; actorEmail: string; disableAutoTopUp?: boolean },
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  const settings = await import("./company-settings").then((m) =>
    m.getCompanySettings(env.DB, input.companyId),
  );
  if (settings?.autoTopUp.enabled && !input.disableAutoTopUp) {
    return {
      ok: false,
      error: "Disable auto top-up before removing your payment method",
      code: "AUTO_TOPUP_ENABLED",
    };
  }

  const row = await env.DB.prepare(
    `SELECT payment_method_id FROM payment_provider_accounts WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(input.companyId)
    .first();
  const pmId = row?.payment_method_id ? String(row.payment_method_id) : null;
  if (!pmId) return { ok: true };

  if (stripePaymentsAllowed(env)) {
    await fetch(`https://api.stripe.com/v1/payment_methods/${pmId}/detach`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
  }

  await env.DB.prepare(
    `UPDATE payment_provider_accounts
     SET payment_method_id = NULL, payment_method_brand = NULL, payment_method_last4 = NULL,
         payment_method_exp_month = NULL, payment_method_exp_year = NULL,
         payment_method_status = 'none', updated_at = ?
     WHERE company_id = ? AND provider = 'stripe'`,
  )
    .bind(nowIso(), input.companyId)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "payment_method.removed",
    actor: input.actorEmail,
    resourceType: "payment_provider",
    resourceId: input.companyId,
  });

  return { ok: true };
}

export {
  getCheckoutById,
  parseCheckoutRow,
};
