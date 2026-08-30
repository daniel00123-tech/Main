import { Hono } from "hono";
import type { Env } from "../env";
import { handleWhatsAppInboundMessage } from "../services/whatsapp-orchestrator";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "../services/whatsapp-assets";

const routes = new Hono<{ Bindings: Env }>();

function authorized(env: Env, request: { header(name: string): string | undefined }): boolean {
  const key = String(env.WHATSAPP_META_PROBE_KEY ?? "").trim();
  return key.length >= 24 && request.header("x-infra-whatsapp-probe") === key;
}

routes.post("/api/internal/whatsapp-ux-uat", async (c) => {
  if (!authorized(c.env, c.req)) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ text?: string }>().catch(() => ({ text: "" }));
  const text = String(body.text ?? "").trim();
  if (!text) return c.json({ error: "text required" }, 400);

  const user = await c.env.DB.prepare(
    `SELECT mobile_e164 FROM users
     WHERE status = 'active' AND mobile_e164 IS NOT NULL AND mobile_e164 != ''
     ORDER BY updated_at DESC LIMIT 1`,
  ).first<{ mobile_e164: string }>();
  if (!user?.mobile_e164) return c.json({ error: "no_linked_user" }, 409);

  const started = Date.now();
  const result = await handleWhatsAppInboundMessage(
    c.env,
    {
      wamid: `wamid.uat.${started}.${Math.random().toString(16).slice(2)}`,
      from: user.mobile_e164.replace(/^\+/, ""),
      type: "text",
      text,
      phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
      businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
      timestamp: String(Math.floor(started / 1000)),
    },
    {
      signatureValid: true,
      alreadyRecorded: true,
      waitUntil: (promise) => {
        try {
          c.executionCtx.waitUntil(promise);
        } catch {
          void promise;
        }
      },
    },
  );
  return c.json({
    ok: result.handled,
    outcome: result.outcome,
    intent: result.intent ?? null,
    acknowledgementSent: Boolean(result.acknowledgementSent),
    replySent: result.replySent,
    publicReply: result.publicReply,
    toolName: result.toolName,
    totalMs: Date.now() - started,
    companyIdPresent: Boolean(result.companyId),
  });
});

export default routes;
