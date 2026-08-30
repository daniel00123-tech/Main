import type { Env } from "../env";
import { recordAuditEvent } from "./control-plane";
import { resolveWhatsAppIdentity } from "./whatsapp-identity";
import { stampWhatsAppLifecycle } from "./whatsapp-lifecycle";
import { tryNormalizeE164 } from "./phone";
import { outboundAiEnabled } from "./whatsapp-assets";
import { instantLocalReply, isInstantLocalTurn } from "./whatsapp-realtime";
import { sendWhatsAppText, type WhatsAppSendResult } from "./whatsapp-send";
import type { WhatsAppParsedInbound } from "./whatsapp-webhook";

export const FIRST_RESPONSE_FAILSAFE_COPY = "Got it 👍 I’m looking at that now.";

export function isWhatsAppFastLaneText(text: string): boolean {
  return isInstantLocalTurn(text);
}

export async function tryWhatsAppFastLane(
  env: Env,
  item: WhatsAppParsedInbound,
): Promise<{
  attempted: boolean;
  sent: boolean;
  reply: string | null;
  send: WhatsAppSendResult | null;
  identityFound: boolean;
  userId: string | null;
  companyId: string | null;
}> {
  const text = (item.text ?? "").trim();
  if (!text || !isWhatsAppFastLaneText(text)) {
    return {
      attempted: false,
      sent: false,
      reply: null,
      send: null,
      identityFound: false,
      userId: null,
      companyId: null,
    };
  }
  const parsed = tryNormalizeE164(item.from);
  const sender = parsed.ok ? parsed.e164 : null;
  const identity = sender ? await resolveWhatsAppIdentity(env.DB, sender).catch(() => null) : null;
  if (!sender || !identity?.found) {
    return {
      attempted: true,
      sent: false,
      reply: null,
      send: null,
      identityFound: false,
      userId: null,
      companyId: null,
    };
  }
  const reply = instantLocalReply(text);
  const send = outboundAiEnabled(env)
    ? await sendWhatsAppText(env, {
        toE164: sender,
        body: reply,
        inCustomerServiceWindow: true,
      }).catch((err): WhatsAppSendResult => ({
        ok: false,
        kind: "customer_service_reply",
        error: err instanceof Error ? err.message : "send_failed",
        retryable: true,
        attempts: 0,
      }))
    : ({
        ok: false,
        kind: "customer_service_reply" as const,
        error: "Outbound WhatsApp is not enabled",
        retryable: false,
        attempts: 0,
      } satisfies WhatsAppSendResult);
  const now = new Date().toISOString();
  const companyId = identity.memberships[0]?.companyId ?? null;
  await stampWhatsAppLifecycle(env, item.wamid, {
    state: send.ok ? "reply_sent" : "validated",
    terminal: send.ok ? "reply_sent" : null,
    identityFound: 1,
    userId: identity.user.id,
    companyId,
    senderE164: sender,
    inboundText: text.slice(0, 500),
    identityResolvedAt: now,
    validatedAt: now,
    firstVisibleAt: send.ok ? now : undefined,
    replySentAt: send.ok ? now : undefined,
    finalSentAt: send.ok ? now : undefined,
    finalSendOk: send.ok ? 1 : 0,
    outboundError: send.ok ? null : send.error,
    lastError: send.ok ? null : send.error,
  });
  if (send.ok) {
    await recordAuditEvent(env.DB, {
      companyId,
      eventType: "whatsapp.conversation",
      actor: identity.user.email,
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: {
        channel: "whatsapp",
        intent: "greeting",
        cheapPath: true,
        costLane: "whatsapp_conversation",
        localGreeting: true,
        fastLane: true,
        outboundMetaMessageId: send.messageId,
        outboundHttpStatus: send.httpStatus ?? 200,
        outboundAttempts: send.attempts,
      },
    }).catch(() => undefined);
  }
  return {
    attempted: true,
    sent: send.ok,
    reply,
    send,
    identityFound: true,
    userId: identity.user.id,
    companyId,
  };
}

export async function sendFirstResponseFailsafe(
  env: Env,
  input: { toE164: string; wamid: string; alreadyVisible: () => boolean },
): Promise<{ sent: boolean; timedOut: boolean }> {
  await new Promise((resolve) => {
    setTimeout(resolve, 1_500);
  });
  if (input.alreadyVisible()) return { sent: false, timedOut: false };
  if (!outboundAiEnabled(env)) return { sent: false, timedOut: true };
  const send = await sendWhatsAppText(env, {
    toE164: input.toE164,
    body: FIRST_RESPONSE_FAILSAFE_COPY,
    inCustomerServiceWindow: true,
  }).catch(() => ({ ok: false as const }));
  if (send.ok) {
    const now = new Date().toISOString();
    await stampWhatsAppLifecycle(env, input.wamid, {
      state: "acknowledged",
      firstVisibleAt: now,
      acknowledgementSentAt: now,
      ackSendOk: 1,
    });
  }
  return { sent: send.ok, timedOut: true };
}
