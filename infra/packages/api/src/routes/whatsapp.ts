import { Hono } from "hono";
import type { Env } from "../env";
import { inboundSignatureRequired } from "../services/whatsapp-assets";
import {
  enqueueWhatsAppInbound,
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
      return c.json({ error: "Webhook signature secret is not configured" }, 503);
    }
    if (!signature.valid) {
      return c.json({ error: "Invalid webhook signature" }, 403);
    }
  } else if (signature.configured && !signature.valid) {
    return c.json({ error: "Invalid webhook signature" }, 403);
  }

  const stored = await persistWhatsAppInboundEvent(c.env, {
    rawBody: rawBody || "{}",
    signatureValid: signature.valid,
    signatureConfigured: signature.configured,
  });

  if (stored.duplicate) {
    return c.json(
      {
        ok: true,
        accepted: true,
        queued: false,
        duplicate: true,
        verifyConfigured: whatsappVerifyConfigured(c.env),
      },
      200,
    );
  }

  const job: WhatsAppInboundMessage = {
    kind: "whatsapp_inbound",
    eventId: stored.eventId,
    receivedAt: new Date().toISOString(),
    signatureValid: signature.valid,
  };

  const queued = await enqueueWhatsAppInbound(c.env, job);
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
    if (!queued) {
      await work;
    }
  }

  return c.json(
    {
      ok: true,
      accepted: true,
      queued,
      verifyConfigured: whatsappVerifyConfigured(c.env),
    },
    200,
  );
});

export default routes;
