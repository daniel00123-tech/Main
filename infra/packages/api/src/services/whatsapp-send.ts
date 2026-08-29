import type { Env } from "../env";
import { redactSecretFields } from "./secrets";
import { inspectWhatsAppAssets, whatsappAccessToken, whatsappPhoneNumberId } from "./whatsapp-assets";

export type WhatsAppSendKind = "customer_service_reply" | "business_initiated_template";

export type WhatsAppSendResult =
  | { ok: true; kind: WhatsAppSendKind; messageId: string | null; attempts: number }
  | { ok: false; kind: WhatsAppSendKind; error: string; retryable: boolean; attempts: number };

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export function classifyWhatsAppOutbound(input: {
  inCustomerServiceWindow: boolean;
  templateName?: string | null;
}): WhatsAppSendKind {
  if (input.templateName) return "business_initiated_template";
  return "customer_service_reply";
}

export async function sendWhatsAppText(
  env: Env,
  input: {
    toE164: string;
    body: string;
    inCustomerServiceWindow: boolean;
  },
): Promise<WhatsAppSendResult> {
  const kind = classifyWhatsAppOutbound({
    inCustomerServiceWindow: input.inCustomerServiceWindow,
  });
  if (!input.inCustomerServiceWindow) {
    return {
      ok: false,
      kind,
      error: "Free-form WhatsApp replies are only allowed inside an active customer-service window.",
      retryable: false,
      attempts: 0,
    };
  }
  return postWhatsAppMessage(env, {
    kind,
    toE164: input.toE164,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digitsOnly(input.toE164),
      type: "text",
      text: { preview_url: false, body: input.body.slice(0, 4000) },
    },
  });
}

export async function sendWhatsAppTemplate(
  env: Env,
  input: { toE164: string; templateName: string; language?: string },
): Promise<WhatsAppSendResult> {
  return postWhatsAppMessage(env, {
    kind: "business_initiated_template",
    toE164: input.toE164,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digitsOnly(input.toE164),
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.language ?? "en_GB" },
      },
    },
  });
}

async function postWhatsAppMessage(
  env: Env,
  input: {
    kind: WhatsAppSendKind;
    toE164: string;
    payload: Record<string, unknown>;
  },
): Promise<WhatsAppSendResult> {
  const assets = inspectWhatsAppAssets(env);
  if (!assets.ok) {
    return { ok: false, kind: input.kind, error: assets.reason ?? "Invalid WhatsApp assets", retryable: false, attempts: 0 };
  }
  const token = whatsappAccessToken(env);
  const phoneNumberId = whatsappPhoneNumberId(env);
  if (!token || !phoneNumberId) {
    return { ok: false, kind: input.kind, error: "WhatsApp send credentials are not configured", retryable: false, attempts: 0 };
  }

  let lastError = "WhatsApp send failed";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.payload),
      });
      const raw = await response.text();
      let parsed: { messages?: Array<{ id?: string }>; error?: { message?: string } } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        parsed = {};
      }
      if (response.ok) {
        return {
          ok: true,
          kind: input.kind,
          messageId: parsed.messages?.[0]?.id ?? null,
          attempts: attempt,
        };
      }
      lastError = publicSendError(parsed.error?.message ?? `HTTP ${response.status}`);
      const retryable = response.status >= 500 || response.status === 429;
      if (!retryable) {
        return { ok: false, kind: input.kind, error: lastError, retryable: false, attempts: attempt };
      }
    } catch (err) {
      lastError = publicSendError(err instanceof Error ? err.message : "network_error");
    }
  }
  return { ok: false, kind: input.kind, error: lastError, retryable: true, attempts: 2 };
}

function digitsOnly(value: string): string {
  return value.replace(/^\+/, "").replace(/\D/g, "");
}

function publicSendError(message: string): string {
  const redacted = String(redactSecretFields({ message }).message ?? "WhatsApp send failed");
  return redacted.replace(/EAA[A-Za-z0-9]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
