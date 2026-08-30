import type { Env } from "../env";
import { redactSecretFields } from "./secrets";
import { inspectWhatsAppAssets, whatsappAccessToken, whatsappPhoneNumberId } from "./whatsapp-assets";
import type { WhatsAppListRow, WhatsAppReplyButton } from "./whatsapp-buttons";
import { clipButtonTitle, shouldAttachButtons } from "./whatsapp-buttons";

export type WhatsAppSendKind = "customer_service_reply" | "business_initiated_template";

export type WhatsAppSendResult =
  | {
      ok: true;
      kind: WhatsAppSendKind;
      messageId: string | null;
      attempts: number;
      httpStatus: number;
      rawAccepted: true;
    }
  | {
      ok: false;
      kind: WhatsAppSendKind;
      error: string;
      retryable: boolean;
      attempts: number;
      httpStatus: number | null;
      rawAccepted: false;
    };

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
    previewUrl?: boolean;
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
      httpStatus: null,
      rawAccepted: false,
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
      text: { preview_url: Boolean(input.previewUrl), body: input.body.slice(0, 4000) },
    },
  });
}

/**
 * Meta Cloud API typing indicator (Graph v21+).
 * POST /{PHONE_NUMBER_ID}/messages with status=read and typing_indicator.type=text.
 * Shown for ~25 seconds. Safe no-op if Meta rejects it.
 */
export type WhatsAppReceiptResult = {
  ok: boolean;
  supported: boolean;
  error?: string | null;
  status?: number | null;
};

export async function sendWhatsAppReadStatus(
  env: Env,
  input: { messageId: string },
): Promise<WhatsAppReceiptResult> {
  return postWhatsAppReceipt(env, {
    messageId: input.messageId,
    typing: false,
  });
}

export async function sendWhatsAppTypingIndicator(
  env: Env,
  input: { messageId: string },
): Promise<WhatsAppReceiptResult> {
  return postWhatsAppReceipt(env, {
    messageId: input.messageId,
    typing: true,
  });
}

async function postWhatsAppReceipt(
  env: Env,
  input: { messageId: string; typing: boolean },
): Promise<WhatsAppReceiptResult> {
  const token = whatsappAccessToken(env);
  const phoneNumberId = whatsappPhoneNumberId(env);
  if (!token || !phoneNumberId || !input.messageId) {
    return { ok: false, supported: false, error: "not_configured", status: null };
  }
  try {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: input.messageId,
    };
    if (input.typing) body.typing_indicator = { type: "text" };
    const response = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const error = response.ok ? null : `HTTP ${response.status}`;
    return {
      ok: response.ok,
      supported: response.ok || response.status !== 400,
      error,
      status: response.status,
    };
  } catch (err) {
    return {
      ok: false,
      supported: false,
      error: err instanceof Error ? err.message : "network_error",
      status: null,
    };
  }
}

export const WHATSAPP_TYPING_INDICATOR_SUPPORT =
  "Meta Cloud API supports a short typing indicator via POST /{PHONE_NUMBER_ID}/messages with status=read and typing_indicator.type=text (shown ~25s). Text acknowledgements remain the primary UX.";

export async function sendWhatsAppInteractiveButtons(
  env: Env,
  input: {
    toE164: string;
    body: string;
    buttons: WhatsAppReplyButton[];
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
      httpStatus: null,
      rawAccepted: false,
    };
  }
  if (!shouldAttachButtons(input.body, input.buttons)) {
    return sendWhatsAppText(env, {
      toE164: input.toE164,
      body: input.body,
      inCustomerServiceWindow: true,
    });
  }
  return postWhatsAppMessage(env, {
    kind,
    toE164: input.toE164,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digitsOnly(input.toE164),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: input.body.slice(0, 1024) },
        action: {
          buttons: input.buttons.slice(0, 3).map((button) => ({
            type: "reply",
            reply: { id: button.id.slice(0, 256), title: clipButtonTitle(button.title) },
          })),
        },
      },
    },
  });
}

export async function sendWhatsAppInteractiveList(
  env: Env,
  input: {
    toE164: string;
    body: string;
    buttonLabel: string;
    rows: WhatsAppListRow[];
    inCustomerServiceWindow: boolean;
  },
): Promise<WhatsAppSendResult> {
  const kind = classifyWhatsAppOutbound({
    inCustomerServiceWindow: input.inCustomerServiceWindow,
  });
  if (!input.inCustomerServiceWindow || input.rows.length === 0) {
    return sendWhatsAppText(env, {
      toE164: input.toE164,
      body: input.body,
      inCustomerServiceWindow: Boolean(input.inCustomerServiceWindow),
    });
  }
  return postWhatsAppMessage(env, {
    kind,
    toE164: input.toE164,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digitsOnly(input.toE164),
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: input.body.slice(0, 1024) },
        action: {
          button: clipButtonTitle(input.buttonLabel || "Choose"),
          sections: [
            {
              title: "Options",
              rows: input.rows.slice(0, 10).map((row) => ({
                id: row.id.slice(0, 200),
                title: clipButtonTitle(row.title),
                description: row.description?.slice(0, 72),
              })),
            },
          ],
        },
      },
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
    return {
      ok: false,
      kind: input.kind,
      error: assets.reason ?? "Invalid WhatsApp assets",
      retryable: false,
      attempts: 0,
      httpStatus: null,
      rawAccepted: false,
    };
  }
  const token = whatsappAccessToken(env);
  const phoneNumberId = whatsappPhoneNumberId(env);
  if (!token || !phoneNumberId) {
    return {
      ok: false,
      kind: input.kind,
      error: "WhatsApp send credentials are not configured",
      retryable: false,
      attempts: 0,
      httpStatus: null,
      rawAccepted: false,
    };
  }

  let lastError = "WhatsApp send failed";
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.payload),
      });
      lastStatus = response.status;
      const raw = await response.text();
      let parsed: { messages?: Array<{ id?: string }>; error?: { message?: string } } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        parsed = {};
      }
      const messageId = parsed.messages?.[0]?.id ?? null;
      // Only treat as sent when Meta accepted AND returned a message id.
      if (response.ok && messageId) {
        return {
          ok: true,
          kind: input.kind,
          messageId,
          attempts: attempt,
          httpStatus: response.status,
          rawAccepted: true,
        };
      }
      lastError = publicSendError(
        parsed.error?.message ?? (response.ok ? "Meta accepted without message id" : `HTTP ${response.status}`),
      );
      const retryable = !response.ok && (response.status >= 500 || response.status === 429);
      if (!retryable) {
        return {
          ok: false,
          kind: input.kind,
          error: lastError,
          retryable: false,
          attempts: attempt,
          httpStatus: response.status,
          rawAccepted: false,
        };
      }
      if (attempt < 3) await delay(200 * attempt);
    } catch (err) {
      lastError = publicSendError(err instanceof Error ? err.message : "network_error");
      if (attempt < 3) await delay(200 * attempt);
    }
  }
  return {
    ok: false,
    kind: input.kind,
    error: lastError,
    retryable: true,
    attempts: 3,
    httpStatus: lastStatus,
    rawAccepted: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function digitsOnly(value: string): string {
  return value.replace(/^\+/, "").replace(/\D/g, "");
}

function publicSendError(message: string): string {
  const redacted = String(redactSecretFields({ message }).message ?? "WhatsApp send failed");
  return redacted.replace(/EAA[A-Za-z0-9]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
