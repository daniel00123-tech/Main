import { Hono } from "hono";
import type { Env } from "../env";
import { handleWhatsAppInboundMessage } from "../services/whatsapp-orchestrator";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "../services/whatsapp-assets";
import { persistWhatsAppInboundEvent, processWhatsAppInboundJob } from "../services/whatsapp-webhook";

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
      skipPersist?: boolean;
    }>()
    .catch(() => ({} as Record<string, string>));

  const inputKind = body.inputKind === "voice" || body.inputKind === "button" ? body.inputKind : "text";
  const buttonId = String(body.buttonId ?? "").trim();
  const mediaId = String(body.mediaId ?? "").trim();
  const text = String(body.text ?? "").trim();
  if (inputKind === "text" && !text) return c.json({ error: "text required" }, 400);
  if (inputKind === "button" && !buttonId && !text) return c.json({ error: "buttonId required" }, 400);
  if (inputKind === "voice" && !mediaId) return c.json({ error: "mediaId required for live voice" }, 400);

  const LIVE_UAT_E164 = "+447932609444";
  const user = await c.env.DB.prepare(
    `SELECT mobile_e164 FROM users
     WHERE status = 'active'
       AND (mobile_e164 = ? OR mobile_e164 = ?)
     LIMIT 1`,
  )
    .bind(LIVE_UAT_E164, LIVE_UAT_E164.replace(/^\+/, ""))
    .first<{ mobile_e164: string }>();
  if (!user?.mobile_e164) return c.json({ error: "no_linked_user" }, 409);

  const started = Date.now();
  const type = inputKind === "button" ? "interactive" : inputKind === "voice" ? "audio" : "text";
  const skipPersist = body.skipPersist === true;
  const from = user.mobile_e164.replace(/^\+/, "");
  const wamid = skipPersist
    ? `wamid.uat.${started}.${Math.random().toString(16).slice(2)}`
    : `wamid.v42persist.${started}.${Math.random().toString(16).slice(2)}`;
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
              messages: [
                {
                  id: wamid,
                  from,
                  type,
                  timestamp: String(Math.floor(started / 1000)),
                  text: inputKind === "text" && text ? { body: text } : undefined,
                  interactive:
                    inputKind === "button"
                      ? {
                          type: "button_reply",
                          button_reply: {
                            id: buttonId || "summarise",
                            title: String(body.buttonTitle ?? "Summarise"),
                          },
                        }
                      : undefined,
                },
              ],
            },
          },
        ],
      },
    ],
  };

  let persisted: { eventId: string; persisted: boolean; error: string | null } | null = null;
  if (!skipPersist) {
    persisted = await persistWhatsAppInboundEvent(c.env, {
      rawBody: JSON.stringify(payload),
      signatureValid: true,
      signatureConfigured: true,
      webhookStatus: 200,
    });
    await processWhatsAppInboundJob(
      c.env,
      {
        kind: "whatsapp_inbound",
        eventId: persisted.eventId,
        receivedAt: new Date().toISOString(),
        signatureValid: true,
        rawPayload: JSON.stringify(payload),
        wamid,
      },
      {
        waitUntil: (promise) => {
          try {
            c.executionCtx.waitUntil(promise);
          } catch {
            void promise;
          }
        },
      },
    );
    const row = await c.env.DB.prepare(
      `SELECT id, wamid, processed, inbound_text, first_visible_at, reply_sent_at, persist_ok,
              lifecycle_state, terminal_state, planning_at, user_stage, last_error,
              planning_ms, mcp_ms, knowledge_search_ms, fetch_ms, synthesis_ms, outbound_ms, total_ms, slowest_stage
       FROM whatsapp_inbound_events WHERE wamid = ? LIMIT 1`,
    )
      .bind(wamid)
      .first<Record<string, unknown>>()
      .catch(() => null);
    return c.json({
      ok: Boolean(row),
      persistInclusive: true,
      persisted: persisted.persisted,
      persistError: persisted.error,
      eventId: persisted.eventId,
      wamid,
      inboundRow: row,
      terminal: row?.terminal_state ?? null,
      lifecycleState: row?.lifecycle_state ?? null,
      totalMs: Date.now() - started,
    });
  }

  const result = await handleWhatsAppInboundMessage(
    c.env,
    {
      wamid,
      from,
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
    persistInclusive: false,
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
