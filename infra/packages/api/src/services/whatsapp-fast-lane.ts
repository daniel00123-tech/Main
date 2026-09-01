import type { Env } from "../env";
import { recordAuditEvent } from "./control-plane";
import { acknowledgementMessage } from "./whatsapp-conversation";
import { resolveWhatsAppIdentity } from "./whatsapp-identity";
import { claimWhatsAppAck, stampWhatsAppLifecycle } from "./whatsapp-lifecycle";
import { tryNormalizeE164 } from "./phone";
import { outboundAiEnabled } from "./whatsapp-assets";
import { DOCUMENT_CLARIFY_REPLY, instantLocalReply, isGenericDocumentAsk, isInstantLocalTurn } from "./whatsapp-realtime";
import {
  sendWhatsAppReadStatus,
  sendWhatsAppText,
  sendWhatsAppTypingIndicator,
  type WhatsAppSendResult,
} from "./whatsapp-send";
import type { WhatsAppParsedInbound } from "./whatsapp-webhook";

export const FIRST_RESPONSE_FAILSAFE_COPY = "Got it 👍 I’m looking at that now.";
export const WATCHDOG_STILL_WORKING_COPY = "Got it 👍 I’m still working on that.";

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work.then((value) => value).catch(() => null),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms);
    }),
  ]);
}

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
  const identity = sender
    ? await withTimeout(resolveWhatsAppIdentity(env.DB, sender), 400)
    : null;
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
  void sendWhatsAppReadStatus(env, { messageId: item.wamid }).catch(() => undefined);
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
    fastLane: send.ok ? 1 : 0,
    outboundHttpStatus: send.httpStatus ?? null,
    outboundMetaMessageId: send.ok ? send.messageId : null,
    outboundAttempts: send.attempts,
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
  const claimed = await claimWhatsAppAck(env, input.wamid);
  if (!claimed || input.alreadyVisible()) return { sent: false, timedOut: false };
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

/** Recognised business turns: read/typing/ack on the webhook isolate before queue/MCP. */
export async function tryWhatsAppEarlyVisible(
  env: Env,
  item: WhatsAppParsedInbound,
): Promise<{ attempted: boolean; sent: boolean; identityFound: boolean; kind?: "ack" | "clarify"; terminal?: boolean }> {
  const text = (item.text ?? "").trim();
  if (!text || isWhatsAppFastLaneText(text)) {
    return { attempted: false, sent: false, identityFound: false };
  }
  const parsed = tryNormalizeE164(item.from);
  const sender = parsed.ok ? parsed.e164 : null;
  const identity = sender
    ? await withTimeout(resolveWhatsAppIdentity(env.DB, sender), 400)
    : null;
  if (!sender || !identity?.found) {
    return { attempted: true, sent: false, identityFound: false };
  }
  const now = new Date().toISOString();
  const clarify = isGenericDocumentAsk(text);
  await stampWhatsAppLifecycle(env, item.wamid, {
    state: "validated",
    identityFound: 1,
    userId: identity.user.id,
    companyId: identity.memberships[0]?.companyId ?? null,
    senderE164: sender,
    inboundText: text.slice(0, 500),
    identityResolvedAt: now,
    validatedAt: now,
    userStage: "understanding_request",
  });
  const read = await sendWhatsAppReadStatus(env, { messageId: item.wamid }).catch(() => ({
    ok: false,
    error: "read_failed",
  }));
  await sendWhatsAppTypingIndicator(env, { messageId: item.wamid }).catch(() => undefined);
  if (!outboundAiEnabled(env)) {
    return { attempted: true, sent: false, identityFound: true };
  }
  const reply = clarify ? DOCUMENT_CLARIFY_REPLY : acknowledgementMessage(item.wamid + text);
  if (!clarify) {
    const claimed = await claimWhatsAppAck(env, item.wamid);
    if (!claimed) {
      return { attempted: true, sent: false, identityFound: true, kind: "ack", terminal: false };
    }
  }
  const send = await sendWhatsAppText(env, {
    toE164: sender,
    body: reply,
    inCustomerServiceWindow: true,
  }).catch((err): WhatsAppSendResult => ({
    ok: false,
    kind: "customer_service_reply",
    error: err instanceof Error ? err.message : "send_failed",
    retryable: true,
    attempts: 0,
    httpStatus: null,
    rawAccepted: false,
  }));
  if (send.ok) {
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: clarify ? "clarification_sent" : "acknowledged",
      terminal: clarify ? "clarification_sent" : null,
      firstVisibleAt: now,
      acknowledgementSentAt: clarify ? undefined : now,
      replySentAt: clarify ? now : undefined,
      finalSentAt: clarify ? now : undefined,
      readStatusSentAt: now,
      readStatusOk: read.ok ? 1 : 0,
      ackSendOk: clarify ? undefined : 1,
      finalSendOk: clarify ? 1 : undefined,
      outboundHttpStatus: send.httpStatus ?? 200,
      outboundMetaMessageId: send.messageId,
      outboundAttempts: send.attempts,
    });
  }
  return { attempted: true, sent: send.ok, identityFound: true, kind: clarify ? "clarify" : "ack", terminal: clarify };
}
