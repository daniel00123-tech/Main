import { Hono } from "hono";
import type { Env } from "../env";
import { inboundSignatureRequired } from "../services/whatsapp-assets";
import { tryWhatsAppEarlyVisible, tryWhatsAppFastLane } from "../services/whatsapp-fast-lane";
import { stampWhatsAppLifecycle } from "../services/whatsapp-lifecycle";
import {
  enqueueWhatsAppInbound,
  parseWhatsAppInboundMessages,
  persistWhatsAppInboundEvent,
  processWhatsAppInboundJob,
  verifyWhatsAppHubChallenge,
  verifyWhatsAppSignature,
  whatsappVerifyConfigured,
  type WhatsAppInboundMessage,
} from "../services/whatsapp-webhook";

const routes = new Hono<{ Bindings: Env }>();

routes.get("/api/webhooks/whatsapp", (c) => {
  const result = verifyWhatsAppHubChallenge(c.env, {
    mode: c.req.query("hub.mode"),
    token: c.req.query("hub.verify_token"),
    challenge: c.req.query("hub.challenge"),
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  return new Response(result.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

routes.post("/api/webhooks/whatsapp", async (c) => {
  const rawBody = await c.req.text();
  const signature = await verifyWhatsAppSignature(
    c.env,
    rawBody,
    c.req.header("X-Hub-Signature-256") ?? c.req.header("x-hub-signature-256") ?? null,
  );

  if (inboundSignatureRequired(c.env)) {
    if (!signature.configured) {
      await persistWhatsAppInboundEvent(c.env, {
        rawBody: rawBody || "{}",
        signatureValid: false,
        signatureConfigured: false,
        webhookStatus: 503,
        persistError: "signature_secret_missing",
        signatureError: "not_configured",
      }).catch(() => undefined);
      return c.json({ error: "Webhook signature secret is not configured" }, 503);
    }
    if (!signature.valid) {
      await persistWhatsAppInboundEvent(c.env, {
        rawBody: rawBody || "{}",
        signatureValid: false,
        signatureConfigured: true,
        webhookStatus: 403,
        persistError: "signature_rejected",
        signatureError: "invalid",
      }).catch(() => undefined);
      return c.json({ error: "Invalid webhook signature" }, 403);
    }
  } else if (signature.configured && !signature.valid) {
    await persistWhatsAppInboundEvent(c.env, {
      rawBody: rawBody || "{}",
      signatureValid: false,
      signatureConfigured: true,
      webhookStatus: 403,
      persistError: "signature_rejected",
      signatureError: "invalid",
    }).catch(() => undefined);
    return c.json({ error: "Invalid webhook signature" }, 403);
  }

  const inbound = parseWhatsAppInboundMessages(safeParse(rawBody));
  let fastLaneSent = 0;
  let earlyVisibleSent = 0;
  const visibleWamids: string[] = [];
  for (const item of inbound) {
    const lane = await tryWhatsAppFastLane(c.env, item).catch(() => null);
    if (lane?.sent) {
      fastLaneSent += 1;
      visibleWamids.push(item.wamid);
      continue;
    }
    const early = await tryWhatsAppEarlyVisible(c.env, item).catch(() => null);
    if (early?.sent) {
      earlyVisibleSent += 1;
      visibleWamids.push(item.wamid);
    }
  }

  const stored = await persistWhatsAppInboundEvent(c.env, {
    rawBody: rawBody || "{}",
    signatureValid: signature.valid,
    signatureConfigured: signature.configured,
    webhookStatus: 200,
  });

  const nowVisible = new Date().toISOString();
  for (const wamid of visibleWamids) {
    await stampWhatsAppLifecycle(c.env, wamid, {
      state: fastLaneSent > 0 ? "reply_sent" : "acknowledged",
      terminal: fastLaneSent > 0 ? "reply_sent" : null,
      firstVisibleAt: nowVisible,
      replySentAt: fastLaneSent > 0 ? nowVisible : undefined,
    }).catch(() => undefined);
  }

  const job: WhatsAppInboundMessage = {
    kind: "whatsapp_inbound",
    eventId: stored.eventId,
    receivedAt: new Date().toISOString(),
    signatureValid: signature.valid,
    rawPayload: (rawBody || "{}").slice(0, 16_384),
    wamid: inbound[0]?.wamid,
  };

  const queued = stored.duplicate ? true : await enqueueWhatsAppInbound(c.env, job);
  if (!stored.duplicate) {
    for (const stage of ["t5", "t10", "t30"] as const) {
      await enqueueWhatsAppInbound(
        c.env,
        {
          kind: "whatsapp_watchdog",
          eventId: stored.eventId,
          receivedAt: job.receivedAt,
          signatureValid: signature.valid,
          wamid: inbound[0]?.wamid,
          stage,
        },
        { delaySeconds: stage === "t5" ? 5 : stage === "t10" ? 10 : 30 },
      ).catch(() => false);
    }
  }

  // Only run the full consumer on this isolate when the queue is unavailable.
  // Dual-running waitUntil + queue caused CLAIM_BUSY retries that drained to DLQ.
  if (!queued) {
    const work = processWhatsAppInboundJob(c.env, job).catch((err) => {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          service: "infra-api",
          event: "whatsapp.inbound_failed",
          message: err instanceof Error ? err.message : "WhatsApp inbound failed",
        }),
      );
    });
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work;
    }
  }

  return c.json(
    {
      ok: true,
      accepted: true,
      queued,
      persisted: stored.persisted,
      persistError: stored.error,
      duplicate: stored.duplicate,
      fastLaneSent,
      earlyVisibleSent,
      verifyConfigured: whatsappVerifyConfigured(c.env),
    },
    200,
  );
});

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export default routes;
