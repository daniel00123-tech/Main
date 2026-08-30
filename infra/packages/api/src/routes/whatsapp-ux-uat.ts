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
  const body = await c.req
    .json<{
      text?: string;
      inputKind?: "text" | "voice" | "button";
      buttonId?: string;
      buttonTitle?: string;
      mediaId?: string;
      simulate?: "mcp_timeout" | string;
      coalesceMs?: number;
    }>()
    .catch(() => ({} as Record<string, string>));

  const inputKind = body.inputKind === "voice" || body.inputKind === "button" ? body.inputKind : "text";
  const buttonId = String(body.buttonId ?? "").trim();
  const mediaId = String(body.mediaId ?? "").trim();
  const text = String(body.text ?? "").trim();
  if (inputKind === "text" && !text) return c.json({ error: "text required" }, 400);
  if (inputKind === "button" && !buttonId && !text) return c.json({ error: "buttonId required" }, 400);
  if (inputKind === "voice" && !mediaId) return c.json({ error: "mediaId required for live voice" }, 400);

  const user = await c.env.DB.prepare(
    `SELECT mobile_e164 FROM users
     WHERE status = 'active' AND mobile_e164 IS NOT NULL AND mobile_e164 != ''
     ORDER BY updated_at DESC LIMIT 1`,
  ).first<{ mobile_e164: string }>();
  if (!user?.mobile_e164) return c.json({ error: "no_linked_user" }, 409);

  const started = Date.now();
  const type = inputKind === "button" ? "interactive" : inputKind === "voice" ? "audio" : "text";
  const result = await handleWhatsAppInboundMessage(
    c.env,
    {
      wamid: `wamid.uat.${started}.${Math.random().toString(16).slice(2)}`,
      from: user.mobile_e164.replace(/^\+/, ""),
      type,
      text: text || null,
      phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
      businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
      timestamp: String(Math.floor(started / 1000)),
      inputKind,
      mediaId: mediaId || null,
      mimeType: inputKind === "voice" ? "audio/ogg; codecs=opus" : null,
      buttonId: buttonId || null,
      buttonTitle: String(body.buttonTitle ?? "").trim() || null,
    },
    {
      signatureValid: true,
      alreadyRecorded: true,
      simulateMcpTimeout: body.simulate === "mcp_timeout",
      coalesceMs: Number.isFinite(Number(body.coalesceMs)) ? Math.min(500, Math.max(0, Number(body.coalesceMs))) : 0,
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
    planAction: result.planAction ?? null,
    acknowledgementSent: Boolean(result.acknowledgementSent),
    replySent: result.replySent,
    publicReply: result.publicReply,
    toolName: result.toolName,
    inputKind: result.inputKind ?? inputKind,
    buttonsSent: result.buttonsSent ?? 0,
    totalMs: Date.now() - started,
    companyIdPresent: Boolean(result.companyId),
  });
});

export default routes;
