import { newId, nowIso } from "../db/mappers";
import type { Env } from "../env";
import { companyStripeCheckoutAllowed, getCompanyBillingMode } from "./company-billing-mode";
import { recordAuditEvent } from "./control-plane";
import {
  ensureStripeCustomer,
  getStripeMode,
  stripePaymentsAllowed,
  syncDefaultPaymentMethodForCompany,
} from "./stripe";

export type RecurringBillingInterval = "daily" | "weekly" | "monthly" | "yearly";

export type AdminRecurringBillingCompany = {
  id: string;
  name: string;
  slug: string;
  status: string;
  currency: string;
  billingMode: string;
  stripeCustomerId: string | null;
  paymentMethodReady: boolean;
  paymentMethod: {
    id: string | null;
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    status: string | null;
  };
};

export type CompanyRecurringCharge = {
  id: string;
  companyId: string;
  companyName: string;
  companySlug: string;
  stripeSubscriptionId: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  amountCents: number;
  currency: string;
  interval: RecurringBillingInterval;
  description: string;
  status: string;
  failureReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  canceledBy: string | null;
  canceledAt: string | null;
  lastInvoiceId: string | null;
  lastInvoiceStatus: string | null;
  lastInvoiceAt: string | null;
  metadata: Record<string, unknown>;
  paymentMethod: {
    brand: string | null;
    last4: string | null;
  };
};

type ServiceFailureCode =
  | "STRIPE_NOT_CONFIGURED"
  | "COMPANY_NOT_FOUND"
  | "COMPANY_INACTIVE"
  | "BILLING_MODE_BLOCKED"
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "INVALID_INTERVAL"
  | "DESCRIPTION_REQUIRED"
  | "STRIPE_CUSTOMER_FAILED"
  | "NO_PAYMENT_METHOD"
  | "STRIPE_PRODUCT_FAILED"
  | "STRIPE_PRICE_FAILED"
  | "STRIPE_SUBSCRIPTION_FAILED"
  | "CHARGE_NOT_FOUND"
  | "ALREADY_CANCELED"
  | "STRIPE_CANCEL_FAILED";

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ServiceFailureCode; error: string };

const INTERVAL_TO_STRIPE: Record<RecurringBillingInterval, "day" | "week" | "month" | "year"> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

function parseJson(raw: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normaliseCurrency(currency?: string | null): string {
  return (currency || "GBP").trim().toUpperCase();
}

function isRecurringBillingInterval(value: unknown): value is RecurringBillingInterval {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly";
}

function parseCompany(row: Record<string, unknown>): AdminRecurringBillingCompany {
  const paymentMethodId = row.payment_method_id ? String(row.payment_method_id) : null;
  const paymentMethodStatus = row.payment_method_status ? String(row.payment_method_status) : null;
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    status: String(row.status ?? "active"),
    currency: String(row.currency ?? "GBP"),
    billingMode: String(row.billing_mode ?? "test"),
    stripeCustomerId:
      row.stripe_customer_id
        ? String(row.stripe_customer_id)
        : row.external_customer_ref
          ? String(row.external_customer_ref)
          : null,
    paymentMethodReady: Boolean(paymentMethodId && paymentMethodStatus === "active"),
    paymentMethod: {
      id: paymentMethodId,
      brand: row.payment_method_brand ? String(row.payment_method_brand) : null,
      last4: row.payment_method_last4 ? String(row.payment_method_last4) : null,
      expMonth:
        row.payment_method_exp_month == null ? null : Number(row.payment_method_exp_month),
      expYear:
        row.payment_method_exp_year == null ? null : Number(row.payment_method_exp_year),
      status: paymentMethodStatus,
    },
  };
}

function parseCharge(row: Record<string, unknown>): CompanyRecurringCharge {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    companyName: String(row.company_name ?? row.name ?? row.company_id),
    companySlug: String(row.company_slug ?? row.slug ?? ""),
    stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null,
    stripeProductId: row.stripe_product_id ? String(row.stripe_product_id) : null,
    stripePriceId: row.stripe_price_id ? String(row.stripe_price_id) : null,
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    stripePaymentMethodId: row.stripe_payment_method_id
      ? String(row.stripe_payment_method_id)
      : null,
    amountCents: Number(row.amount_cents),
    currency: String(row.currency ?? "GBP"),
    interval: String(row.interval) as RecurringBillingInterval,
    description: String(row.description ?? ""),
    status: String(row.status ?? "unknown"),
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    canceledBy: row.canceled_by ? String(row.canceled_by) : null,
    canceledAt: row.canceled_at ? String(row.canceled_at) : null,
    lastInvoiceId: row.last_invoice_id ? String(row.last_invoice_id) : null,
    lastInvoiceStatus: row.last_invoice_status ? String(row.last_invoice_status) : null,
    lastInvoiceAt: row.last_invoice_at ? String(row.last_invoice_at) : null,
    metadata: parseJson(row.metadata_json),
    paymentMethod: {
      brand: row.payment_method_brand ? String(row.payment_method_brand) : null,
      last4: row.payment_method_last4 ? String(row.payment_method_last4) : null,
    },
  };
}

async function stripeRequest(
  env: Env,
  path: string,
  options: {
    method?: string;
    body?: URLSearchParams;
    idempotencyKey?: string;
  } = {},
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(options.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: options.body?.toString(),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

function stripeError(data: Record<string, unknown>, fallback: string): string {
  const error = data.error as { message?: string } | undefined;
  return error?.message ?? fallback;
}

async function getCompanyForBilling(
  db: D1Database,
  companyId: string,
): Promise<AdminRecurringBillingCompany | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.status, c.currency, c.billing_mode,
              cb.stripe_customer_id,
              ppa.external_customer_ref,
              ppa.payment_method_id,
              ppa.payment_method_brand,
              ppa.payment_method_last4,
              ppa.payment_method_exp_month,
              ppa.payment_method_exp_year,
              ppa.payment_method_status
       FROM companies c
       LEFT JOIN credit_balances cb ON cb.company_id = c.id
       LEFT JOIN payment_provider_accounts ppa
         ON ppa.company_id = c.id AND ppa.provider = 'stripe'
       WHERE c.id = ?`,
    )
    .bind(companyId)
    .first();
  return row ? parseCompany(row as Record<string, unknown>) : null;
}

async function getPaymentProviderRow(db: D1Database, companyId: string) {
  return db
    .prepare(
      `SELECT payment_method_id, payment_method_brand, payment_method_last4,
              payment_method_status
       FROM payment_provider_accounts
       WHERE company_id = ? AND provider = 'stripe'`,
    )
    .bind(companyId)
    .first();
}

async function resolveSavedPaymentMethod(
  env: Env,
  companyId: string,
): Promise<
  | { ok: true; paymentMethodId: string; brand: string | null; last4: string | null }
  | { ok: false; error: string }
> {
  let provider = await getPaymentProviderRow(env.DB, companyId);
  const storedPaymentMethodId = provider?.payment_method_id
    ? String(provider.payment_method_id)
    : null;
  if (storedPaymentMethodId && String(provider?.payment_method_status ?? "") === "active") {
    return {
      ok: true,
      paymentMethodId: storedPaymentMethodId,
      brand: provider?.payment_method_brand ? String(provider.payment_method_brand) : null,
      last4: provider?.payment_method_last4 ? String(provider.payment_method_last4) : null,
    };
  }

  const synced = await syncDefaultPaymentMethodForCompany(env, companyId);
  if (!synced.ok) return { ok: false, error: synced.error };

  provider = await getPaymentProviderRow(env.DB, companyId);
  const paymentMethodId = provider?.payment_method_id
    ? String(provider.payment_method_id)
    : null;
  if (!paymentMethodId || String(provider?.payment_method_status ?? "") !== "active") {
    return { ok: false, error: "No payment method on file" };
  }

  return {
    ok: true,
    paymentMethodId,
    brand: provider?.payment_method_brand ? String(provider.payment_method_brand) : synced.brand,
    last4: provider?.payment_method_last4 ? String(provider.payment_method_last4) : synced.last4,
  };
}

export async function listRecurringBillingCompanies(
  db: D1Database,
): Promise<AdminRecurringBillingCompany[]> {
  const rows = await db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.status, c.currency, c.billing_mode,
              cb.stripe_customer_id,
              ppa.external_customer_ref,
              ppa.payment_method_id,
              ppa.payment_method_brand,
              ppa.payment_method_last4,
              ppa.payment_method_exp_month,
              ppa.payment_method_exp_year,
              ppa.payment_method_status
       FROM companies c
       LEFT JOIN credit_balances cb ON cb.company_id = c.id
       LEFT JOIN payment_provider_accounts ppa
         ON ppa.company_id = c.id AND ppa.provider = 'stripe'
       WHERE c.archived_at IS NULL
       ORDER BY c.name ASC`,
    )
    .all();
  return (rows.results ?? []).map((row) => parseCompany(row as Record<string, unknown>));
}

export async function listCompanyRecurringCharges(
  db: D1Database,
): Promise<CompanyRecurringCharge[]> {
  const rows = await db
    .prepare(
      `SELECT crc.*,
              c.name AS company_name,
              c.slug AS company_slug,
              ppa.payment_method_brand,
              ppa.payment_method_last4
       FROM company_recurring_charges crc
       LEFT JOIN companies c ON c.id = crc.company_id
       LEFT JOIN payment_provider_accounts ppa
         ON ppa.company_id = crc.company_id AND ppa.provider = 'stripe'
       ORDER BY
         CASE WHEN crc.status IN ('active', 'trialing', 'past_due', 'unpaid', 'incomplete')
              THEN 0 ELSE 1 END,
         crc.created_at DESC`,
    )
    .all();
  return (rows.results ?? []).map((row) => parseCharge(row as Record<string, unknown>));
}

async function updateChargeFailure(db: D1Database, chargeId: string, reason: string) {
  await db
    .prepare(
      `UPDATE company_recurring_charges
       SET status = 'failed', failure_reason = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(reason, nowIso(), chargeId)
    .run();
}

export async function createCompanyRecurringCharge(
  env: Env,
  input: {
    companyId: string;
    amountCents: number;
    currency?: string | null;
    interval: RecurringBillingInterval;
    description: string;
    createdBy: string;
  },
): Promise<ServiceResult<CompanyRecurringCharge>> {
  const currency = normaliseCurrency(input.currency);
  if (currency !== "GBP") {
    return { ok: false, code: "INVALID_CURRENCY", error: "Only GBP recurring charges are supported in v1" };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Enter an amount greater than £0.00" };
  }
  if (input.amountCents > 100000_00) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Amount cannot exceed £100,000.00" };
  }
  if (!isRecurringBillingInterval(input.interval)) {
    return { ok: false, code: "INVALID_INTERVAL", error: "Frequency must be daily, weekly, monthly, or yearly" };
  }
  const description = input.description.trim();
  if (description.length < 3) {
    return { ok: false, code: "DESCRIPTION_REQUIRED", error: "Description is required" };
  }

  if (!stripePaymentsAllowed(env)) {
    return { ok: false, code: "STRIPE_NOT_CONFIGURED", error: "Stripe payments are not configured" };
  }

  const company = await getCompanyForBilling(env.DB, input.companyId);
  if (!company) {
    return { ok: false, code: "COMPANY_NOT_FOUND", error: "Company not found" };
  }
  if (company.status === "suspended" || company.status === "archived" || company.status === "closed") {
    return { ok: false, code: "COMPANY_INACTIVE", error: "Company is not active for billing" };
  }

  const companyBillingMode = await getCompanyBillingMode(env.DB, input.companyId);
  const chargeGate = companyStripeCheckoutAllowed(env, companyBillingMode);
  if (!chargeGate.allowed) {
    return {
      ok: false,
      code: "BILLING_MODE_BLOCKED",
      error: chargeGate.reason ?? "Stripe charging is not allowed for this company",
    };
  }

  const customer = await ensureStripeCustomer(env, {
    companyId: company.id,
    companyName: company.name,
    actorEmail: input.createdBy,
  });
  if (!customer.ok) {
    return { ok: false, code: "STRIPE_CUSTOMER_FAILED", error: customer.error };
  }

  const paymentMethod = await resolveSavedPaymentMethod(env, company.id);
  if (!paymentMethod.ok) {
    return {
      ok: false,
      code: "NO_PAYMENT_METHOD",
      error: "No saved payment method on file for this company. Ask the company to add a card in their billing portal first.",
    };
  }

  const chargeId = newId("recurring");
  const now = nowIso();
  const metadata = {
    stripeMode: getStripeMode(env),
    source: "admin_recurring_company_billing",
  };

  await env.DB.prepare(
    `INSERT INTO company_recurring_charges (
      id, company_id, stripe_subscription_id, stripe_product_id, stripe_price_id,
      stripe_customer_id, stripe_payment_method_id, amount_cents, currency,
      interval, description, status, failure_reason, created_by, created_at,
      updated_at, metadata_json
    ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'creating', NULL, ?, ?, ?, ?)`,
  )
    .bind(
      chargeId,
      company.id,
      customer.customerId,
      paymentMethod.paymentMethodId,
      input.amountCents,
      currency,
      input.interval,
      description,
      input.createdBy,
      now,
      now,
      JSON.stringify(metadata),
    )
    .run();

  const productParams = new URLSearchParams();
  productParams.set("name", `INFRA recurring charge - ${company.name}`);
  productParams.set("description", description);
  productParams.set("metadata[company_id]", company.id);
  productParams.set("metadata[infra_company_id]", company.id);
  productParams.set("metadata[infra_recurring_charge_id]", chargeId);

  const product = await stripeRequest(env, "/v1/products", {
    method: "POST",
    body: productParams,
    idempotencyKey: `${chargeId}_product`,
  });
  if (!product.ok || !product.data.id) {
    const error = stripeError(product.data, "Unable to create Stripe product");
    await updateChargeFailure(env.DB, chargeId, error);
    return { ok: false, code: "STRIPE_PRODUCT_FAILED", error };
  }

  const priceParams = new URLSearchParams();
  priceParams.set("currency", currency.toLowerCase());
  priceParams.set("unit_amount", String(input.amountCents));
  priceParams.set("product", String(product.data.id));
  priceParams.set("recurring[interval]", INTERVAL_TO_STRIPE[input.interval]);
  priceParams.set("metadata[company_id]", company.id);
  priceParams.set("metadata[infra_company_id]", company.id);
  priceParams.set("metadata[infra_recurring_charge_id]", chargeId);

  const price = await stripeRequest(env, "/v1/prices", {
    method: "POST",
    body: priceParams,
    idempotencyKey: `${chargeId}_price`,
  });
  if (!price.ok || !price.data.id) {
    const error = stripeError(price.data, "Unable to create Stripe price");
    await updateChargeFailure(env.DB, chargeId, error);
    return { ok: false, code: "STRIPE_PRICE_FAILED", error };
  }

  const subscriptionParams = new URLSearchParams();
  subscriptionParams.set("customer", customer.customerId);
  subscriptionParams.set("default_payment_method", paymentMethod.paymentMethodId);
  subscriptionParams.set("collection_method", "charge_automatically");
  subscriptionParams.set("payment_behavior", "error_if_incomplete");
  subscriptionParams.set("items[0][price]", String(price.data.id));
  subscriptionParams.set("description", description);
  subscriptionParams.set("metadata[company_id]", company.id);
  subscriptionParams.set("metadata[infra_company_id]", company.id);
  subscriptionParams.set("metadata[infra_recurring_charge_id]", chargeId);
  subscriptionParams.set("metadata[created_by]", input.createdBy);
  subscriptionParams.set("expand[]", "latest_invoice");

  const subscription = await stripeRequest(env, "/v1/subscriptions", {
    method: "POST",
    body: subscriptionParams,
    idempotencyKey: `${chargeId}_subscription`,
  });
  if (!subscription.ok || !subscription.data.id) {
    const error = stripeError(subscription.data, "Unable to create Stripe subscription");
    await updateChargeFailure(env.DB, chargeId, error);
    return { ok: false, code: "STRIPE_SUBSCRIPTION_FAILED", error };
  }

  const status = subscription.data.status ? String(subscription.data.status) : "active";
  const latestInvoice = subscription.data.latest_invoice;
  const latestInvoiceId =
    latestInvoice && typeof latestInvoice === "object"
      ? String((latestInvoice as Record<string, unknown>).id ?? "")
      : typeof latestInvoice === "string"
        ? latestInvoice
        : null;

  await env.DB.prepare(
    `UPDATE company_recurring_charges
     SET stripe_subscription_id = ?, stripe_product_id = ?, stripe_price_id = ?,
         status = ?, updated_at = ?, last_invoice_id = ?
     WHERE id = ?`,
  )
    .bind(
      String(subscription.data.id),
      String(product.data.id),
      String(price.data.id),
      status,
      nowIso(),
      latestInvoiceId,
      chargeId,
    )
    .run();

  await recordAuditEvent(env.DB, {
    companyId: company.id,
    eventType: "billing.recurring_charge.created",
    actor: input.createdBy,
    resourceType: "company_recurring_charge",
    resourceId: chargeId,
    detail: {
      amountCents: input.amountCents,
      currency,
      interval: input.interval,
      stripeSubscriptionId: String(subscription.data.id),
      stripeMode: getStripeMode(env),
    },
  });

  const saved = await getCompanyRecurringCharge(env.DB, chargeId);
  if (!saved) {
    return { ok: false, code: "CHARGE_NOT_FOUND", error: "Recurring charge was created but could not be reloaded" };
  }
  return { ok: true, value: saved };
}

export async function getCompanyRecurringCharge(
  db: D1Database,
  chargeId: string,
): Promise<CompanyRecurringCharge | null> {
  const row = await db
    .prepare(
      `SELECT crc.*,
              c.name AS company_name,
              c.slug AS company_slug,
              ppa.payment_method_brand,
              ppa.payment_method_last4
       FROM company_recurring_charges crc
       LEFT JOIN companies c ON c.id = crc.company_id
       LEFT JOIN payment_provider_accounts ppa
         ON ppa.company_id = crc.company_id AND ppa.provider = 'stripe'
       WHERE crc.id = ?`,
    )
    .bind(chargeId)
    .first();
  return row ? parseCharge(row as Record<string, unknown>) : null;
}

export async function cancelCompanyRecurringCharge(
  env: Env,
  input: { chargeId: string; actorEmail: string },
): Promise<ServiceResult<CompanyRecurringCharge>> {
  if (!stripePaymentsAllowed(env)) {
    return { ok: false, code: "STRIPE_NOT_CONFIGURED", error: "Stripe payments are not configured" };
  }

  const charge = await getCompanyRecurringCharge(env.DB, input.chargeId);
  if (!charge || !charge.stripeSubscriptionId) {
    return { ok: false, code: "CHARGE_NOT_FOUND", error: "Recurring charge not found" };
  }
  if (charge.status === "canceled") {
    return { ok: false, code: "ALREADY_CANCELED", error: "Recurring charge is already canceled" };
  }

  const params = new URLSearchParams();
  params.set("invoice_now", "false");
  params.set("prorate", "false");
  const canceled = await stripeRequest(
    env,
    `/v1/subscriptions/${encodeURIComponent(charge.stripeSubscriptionId)}`,
    { method: "DELETE", body: params },
  );
  if (!canceled.ok) {
    return {
      ok: false,
      code: "STRIPE_CANCEL_FAILED",
      error: stripeError(canceled.data, "Unable to cancel Stripe subscription"),
    };
  }

  await env.DB.prepare(
    `UPDATE company_recurring_charges
     SET status = 'canceled', canceled_by = ?, canceled_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(input.actorEmail, nowIso(), nowIso(), charge.id)
    .run();

  await recordAuditEvent(env.DB, {
    companyId: charge.companyId,
    eventType: "billing.recurring_charge.canceled",
    actor: input.actorEmail,
    resourceType: "company_recurring_charge",
    resourceId: charge.id,
    detail: { stripeSubscriptionId: charge.stripeSubscriptionId },
  });

  const saved = await getCompanyRecurringCharge(env.DB, charge.id);
  return saved
    ? { ok: true, value: saved }
    : { ok: false, code: "CHARGE_NOT_FOUND", error: "Recurring charge not found" };
}

function objectFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data as { object?: Record<string, unknown> } | undefined;
  return data?.object ?? {};
}

function metadataValue(object: Record<string, unknown>, key: string): string | null {
  const metadata = object.metadata as Record<string, string> | undefined;
  return metadata?.[key] ? String(metadata[key]) : null;
}

async function updateChargeBySubscription(
  db: D1Database,
  subscriptionId: string,
  patch: {
    status?: string;
    canceledBy?: string | null;
    canceledAt?: string | null;
    lastInvoiceId?: string | null;
    lastInvoiceStatus?: string | null;
    lastInvoiceAt?: string | null;
  },
): Promise<CompanyRecurringCharge | null> {
  const existing = await db
    .prepare(`SELECT id FROM company_recurring_charges WHERE stripe_subscription_id = ?`)
    .bind(subscriptionId)
    .first();
  if (!existing) return null;

  await db
    .prepare(
      `UPDATE company_recurring_charges
       SET status = COALESCE(?, status),
           canceled_by = COALESCE(?, canceled_by),
           canceled_at = COALESCE(?, canceled_at),
           last_invoice_id = COALESCE(?, last_invoice_id),
           last_invoice_status = COALESCE(?, last_invoice_status),
           last_invoice_at = COALESCE(?, last_invoice_at),
           updated_at = ?
       WHERE stripe_subscription_id = ?`,
    )
    .bind(
      patch.status ?? null,
      patch.canceledBy ?? null,
      patch.canceledAt ?? null,
      patch.lastInvoiceId ?? null,
      patch.lastInvoiceStatus ?? null,
      patch.lastInvoiceAt ?? null,
      nowIso(),
      subscriptionId,
    )
    .run();

  return getCompanyRecurringCharge(db, String(existing.id));
}

export async function processRecurringCompanyBillingWebhook(
  env: Env,
  input: {
    stripeEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<{ processed: boolean; duplicate: boolean; message: string; code?: string }> {
  const object = objectFromPayload(input.payload);

  if (input.eventType === "invoice.paid" || input.eventType === "invoice.payment_failed") {
    const subscriptionId = object.subscription ? String(object.subscription) : null;
    if (!subscriptionId) {
      return { processed: false, duplicate: false, message: "Invoice has no subscription", code: "NO_SUBSCRIPTION" };
    }
    const charge = await updateChargeBySubscription(env.DB, subscriptionId, {
      lastInvoiceId: object.id ? String(object.id) : null,
      lastInvoiceStatus: input.eventType === "invoice.paid" ? "paid" : "payment_failed",
      lastInvoiceAt: nowIso(),
      status: input.eventType === "invoice.payment_failed" ? "past_due" : undefined,
    });
    if (!charge) {
      return { processed: false, duplicate: false, message: "Recurring charge not found", code: "UNKNOWN_RECURRING_CHARGE" };
    }
    await recordAuditEvent(env.DB, {
      companyId: charge.companyId,
      eventType:
        input.eventType === "invoice.paid"
          ? "billing.recurring_charge.invoice_paid"
          : "billing.recurring_charge.invoice_failed",
      actor: "stripe-webhook",
      resourceType: "company_recurring_charge",
      resourceId: charge.id,
      detail: {
        stripeEventId: input.stripeEventId,
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: object.id ? String(object.id) : null,
      },
    });
    return { processed: true, duplicate: false, message: input.eventType };
  }

  if (
    input.eventType === "customer.subscription.deleted" ||
    input.eventType === "customer.subscription.updated"
  ) {
    const subscriptionId =
      object.id ? String(object.id) : metadataValue(object, "stripe_subscription_id");
    if (!subscriptionId) {
      return { processed: false, duplicate: false, message: "Subscription id missing", code: "NO_SUBSCRIPTION" };
    }
    const stripeStatus = object.status ? String(object.status) : null;
    const canceledAtSeconds = object.canceled_at != null ? Number(object.canceled_at) : null;
    const canceledAt =
      canceledAtSeconds && Number.isFinite(canceledAtSeconds)
        ? new Date(canceledAtSeconds * 1000).toISOString()
        : input.eventType === "customer.subscription.deleted"
          ? nowIso()
          : null;
    const charge = await updateChargeBySubscription(env.DB, subscriptionId, {
      status: input.eventType === "customer.subscription.deleted" ? "canceled" : stripeStatus ?? undefined,
      canceledBy:
        input.eventType === "customer.subscription.deleted" || stripeStatus === "canceled"
          ? "stripe-webhook"
          : undefined,
      canceledAt:
        input.eventType === "customer.subscription.deleted" || stripeStatus === "canceled"
          ? canceledAt ?? nowIso()
          : undefined,
    });
    if (!charge) {
      return { processed: false, duplicate: false, message: "Recurring charge not found", code: "UNKNOWN_RECURRING_CHARGE" };
    }
    if (input.eventType === "customer.subscription.deleted" || stripeStatus === "canceled") {
      await recordAuditEvent(env.DB, {
        companyId: charge.companyId,
        eventType: "billing.recurring_charge.canceled",
        actor: "stripe-webhook",
        resourceType: "company_recurring_charge",
        resourceId: charge.id,
        detail: {
          stripeEventId: input.stripeEventId,
          stripeSubscriptionId: subscriptionId,
        },
      });
    }
    return { processed: true, duplicate: false, message: input.eventType };
  }

  return { processed: true, duplicate: false, message: "ignored recurring billing event" };
}

export function isActiveRecurringCharge(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}
