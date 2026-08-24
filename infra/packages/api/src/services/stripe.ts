import { newId, nowIso } from "../db/mappers";
import { appendLedgerEntry } from "./ledger";
import { recordAuditEvent } from "./control-plane";
import type { Env } from "../env";

export function isStripeConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

export async function createTopUpCheckoutIntent(
  env: Env,
  input: {
    companyId: string;
    amountCents: number;
    createdBy: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<
  | { configured: false; error: string }
  | {
      configured: true;
      checkoutSessionId: string;
      url: string | null;
      localId: string;
      mode: "live_api" | "pending_credentials";
    }
> {
  if (input.amountCents < 500) {
    return { configured: false, error: "Minimum top-up is £5.00" };
  }

  const localId = newId("stripe_co");
  const createdAt = nowIso();

  await env.DB.prepare(
    `INSERT INTO stripe_checkout_sessions (
      id, company_id, stripe_session_id, amount_cents, currency, status,
      created_by, created_at, completed_at, metadata_json
    ) VALUES (?, ?, NULL, ?, 'GBP', 'pending', ?, ?, NULL, ?)`,
  )
    .bind(
      localId,
      input.companyId,
      input.amountCents,
      input.createdBy,
      createdAt,
      JSON.stringify({ successUrl: input.successUrl, cancelUrl: input.cancelUrl }),
    )
    .run();

  if (!isStripeConfigured(env)) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "billing.credit_adjusted",
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
    };
  }

  // Application-side Stripe Checkout Session create
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  params.set("client_reference_id", localId);
  params.set("metadata[company_id]", input.companyId);
  params.set("metadata[infra_checkout_id]", localId);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "gbp");
  params.set(
    "line_items[0][price_data][unit_amount]",
    String(input.amountCents),
  );
  params.set(
    "line_items[0][price_data][product_data][name]",
    "INFRA prepaid credit",
  );

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
      `UPDATE stripe_checkout_sessions SET status = 'failed' WHERE id = ?`,
    )
      .bind(localId)
      .run();
    return {
      configured: false,
      error: body.error?.message ?? "Stripe checkout session failed",
    };
  }

  await env.DB.prepare(
    `UPDATE stripe_checkout_sessions
     SET stripe_session_id = ?, status = 'open' WHERE id = ?`,
  )
    .bind(body.id, localId)
    .run();

  return {
    configured: true,
    checkoutSessionId: body.id,
    url: body.url ?? null,
    localId,
    mode: "live_api",
  };
}

/** Idempotent webhook processing — credits ledger once per Stripe event. */
export async function processStripeWebhookEvent(
  env: Env,
  input: {
    stripeEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<{ processed: boolean; duplicate: boolean; message: string }> {
  const existing = await env.DB.prepare(
    `SELECT * FROM stripe_webhook_events WHERE stripe_event_id = ?`,
  )
    .bind(input.stripeEventId)
    .first();

  if (existing && Number(existing.processed) === 1) {
    return {
      processed: false,
      duplicate: true,
      message: "Event already processed",
    };
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

  if (input.eventType === "checkout.session.completed") {
    const session = input.payload.data as
      | { object?: Record<string, unknown> }
      | undefined;
    const object = session?.object ?? {};
    const stripeSessionId = String(object.id ?? "");
    const localId = String(
      (object.metadata as Record<string, string> | undefined)
        ?.infra_checkout_id ??
        object.client_reference_id ??
        "",
    );

    const checkout = localId
      ? await env.DB.prepare(
          `SELECT * FROM stripe_checkout_sessions WHERE id = ?`,
        )
          .bind(localId)
          .first()
      : await env.DB.prepare(
          `SELECT * FROM stripe_checkout_sessions WHERE stripe_session_id = ?`,
        )
          .bind(stripeSessionId)
          .first();

    if (!checkout) {
      await env.DB.prepare(
        `UPDATE stripe_webhook_events
         SET error_message = ?, processed = 1, processed_at = ?
         WHERE stripe_event_id = ?`,
      )
        .bind("Checkout session not found", nowIso(), input.stripeEventId)
        .run();
      return {
        processed: false,
        duplicate: false,
        message: "Checkout session not found",
      };
    }

    if (String(checkout.status) === "completed") {
      await env.DB.prepare(
        `UPDATE stripe_webhook_events
         SET processed = 1, processed_at = ? WHERE stripe_event_id = ?`,
      )
        .bind(nowIso(), input.stripeEventId)
        .run();
      return {
        processed: false,
        duplicate: true,
        message: "Checkout already completed",
      };
    }

    const amountCents = Number(checkout.amount_cents);
    const companyId = String(checkout.company_id);

    await appendLedgerEntry(env.DB, {
      companyId,
      entryType: "top_up",
      amountCents,
      referenceType: "stripe_checkout",
      referenceId: String(checkout.id),
      description: `Stripe top-up £${(amountCents / 100).toFixed(2)}`,
      metadata: { stripeSessionId, stripeEventId: input.stripeEventId },
      createdBy: "stripe-webhook",
    });

    await env.DB.prepare(
      `UPDATE stripe_checkout_sessions
       SET status = 'completed', completed_at = ?, stripe_session_id = COALESCE(stripe_session_id, ?)
       WHERE id = ?`,
    )
      .bind(nowIso(), stripeSessionId || null, String(checkout.id))
      .run();

    await recordAuditEvent(env.DB, {
      companyId,
      eventType: "billing.credit_adjusted",
      actor: "stripe-webhook",
      resourceType: "ledger",
      resourceId: String(checkout.id),
      detail: { amountCents, entryType: "top_up" },
    });
  }

  await env.DB.prepare(
    `UPDATE stripe_webhook_events
     SET processed = 1, processed_at = ? WHERE stripe_event_id = ?`,
  )
    .bind(nowIso(), input.stripeEventId)
    .run();

  return { processed: true, duplicate: false, message: "ok" };
}

/** Verify Stripe webhook signature (v1). Returns false if secrets missing or invalid. */
export async function verifyStripeWebhookSignature(
  env: Env,
  payload: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!env.STRIPE_WEBHOOK_SECRET || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [k, v] = part.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expected === signature;
}
