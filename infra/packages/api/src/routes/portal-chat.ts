import { Hono } from "hono";
import type { AuthVariables } from "../auth/middleware";
import { requireAuth } from "../auth/middleware";
import type { Env } from "../env";
import { getCompanyBySlug, recordAuditEvent } from "../services/control-plane";
import {
  PortalChatError,
  createPortalConversation,
  getPortalConversation,
  getPortalConversationWithRetry,
  listPortalConversations,
  renamePortalConversation,
  resolvePortalChatAccess,
  sendPortalChatMessage,
} from "../services/portal-chat";
import { transcribePortalVoice } from "../services/portal-transcribe";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const routes = new Hono<AppEnv>();

async function companyContext(c: {
  env: Env;
  get: (key: "user") => AuthVariables["user"];
  req: { param: (name: string) => string };
}) {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return { error: "Company not found" as const, status: 404 as const };
  const access = await resolvePortalChatAccess(c.env.DB, c.get("user"), company.id);
  if (!access.ok) {
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "permission.denied",
      actor: c.get("user").email,
      resourceType: "portal_chat",
      resourceId: company.id,
      detail: { reason: access.error },
    });
    return { error: access.error, status: access.status };
  }
  return { company, access };
}

function readMessageText(body: Record<string, unknown>): string {
  if (typeof body.text === "string") return body.text;
  if (typeof body.message === "string") return body.message;
  return "";
}

export function portalChatErrorStatus(error: PortalChatError): 400 | 402 | 404 {
  if (error.status === 402) return 402;
  if (error.status === 400) return 400;
  return 404;
}

async function streamTurn(
  c: { env: Env; executionCtx: ExecutionContext },
  input: Parameters<typeof sendPortalChatMessage>[1],
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const result = await sendPortalChatMessage(c.env, {
          ...input,
          waitUntil: (promise) => c.executionCtx.waitUntil(promise),
          onStatus: (status) => {
            void send("status", status);
          },
        });
        await send("user", result.userMessage);
        await send("done", result);
      } catch (error) {
        const message = error instanceof PortalChatError ? error.message : "Unable to complete that chat turn";
        const status = error instanceof PortalChatError ? portalChatErrorStatus(error) : 500;
        await send("error", { error: message, status });
      } finally {
        await writer.close();
      }
    })(),
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

routes.get("/api/companies/:slug/chat/conversations", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  return c.json({ conversations: await listPortalConversations(c.env.DB, ctx.company.id, ctx.access.sessionUser.userId) });
});

routes.post("/api/companies/:slug/chat/conversations", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const body = await c.req.json().catch(() => ({}));
  const conversation = await createPortalConversation(c.env.DB, {
    companyId: ctx.company.id,
    userId: ctx.access.sessionUser.userId,
    title: typeof body.title === "string" ? body.title : undefined,
  });
  return c.json({ conversation }, 201);
});

routes.get("/api/companies/:slug/chat/conversations/:id", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const conversation = await getPortalConversationWithRetry(c.env.DB, {
    conversationId: c.req.param("id"),
    companyId: ctx.company.id,
    userId: ctx.access.sessionUser.userId,
  });
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ conversation });
});

routes.patch("/api/companies/:slug/chat/conversations/:id", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const body = await c.req.json().catch(() => ({}));
  const conversation = await renamePortalConversation(c.env.DB, {
    conversationId: c.req.param("id"),
    companyId: ctx.company.id,
    userId: ctx.access.sessionUser.userId,
    title: typeof body.title === "string" ? body.title : "",
  });
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ conversation });
});

routes.post("/api/companies/:slug/chat/conversations/:id/messages", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(
      await sendPortalChatMessage(c.env, {
        companyId: ctx.company.id,
        sessionUser: ctx.access.sessionUser,
        conversationId: c.req.param("id"),
        text: readMessageText(body),
        userAgent: c.req.header("User-Agent") ?? null,
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      }),
    );
  } catch (error) {
    if (error instanceof PortalChatError) return c.json({ error: error.message }, portalChatErrorStatus(error));
    throw error;
  }
});

routes.post("/api/companies/:slug/chat/messages", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(
      await sendPortalChatMessage(c.env, {
        companyId: ctx.company.id,
        sessionUser: ctx.access.sessionUser,
        conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
        text: readMessageText(body),
        userAgent: c.req.header("User-Agent") ?? null,
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      }),
    );
  } catch (error) {
    if (error instanceof PortalChatError) return c.json({ error: error.message }, portalChatErrorStatus(error));
    throw error;
  }
});

routes.post("/api/companies/:slug/chat/conversations/:id/messages/stream", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return streamTurn(c, {
    companyId: ctx.company.id,
    sessionUser: ctx.access.sessionUser,
    conversationId: c.req.param("id"),
    text: readMessageText(body),
    userAgent: c.req.header("User-Agent") ?? null,
  });
});

routes.post("/api/companies/:slug/chat/transcribe", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) return c.json({ error: "Audio is required." }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await transcribePortalVoice(c.env, {
    companyId: ctx.company.id,
    actor: c.get("user").email,
    bytes,
    mimeType: file.type || "audio/webm",
    filename: file.name || "portal-voice.webm",
  });
  if (!result.ok) {
    const status = result.reason === "not_configured" || result.reason === "provider_error" ? 502 : 400;
    return c.json({ error: "Voice transcription failed. You can still type your message.", reason: result.reason }, status);
  }
  return c.json({
    text: result.text,
    provider: result.provider,
    model: result.model,
    customerChargeCents: 0,
  });
});

routes.post("/api/companies/:slug/chat/messages/stream", requireAuth, async (c) => {
  const ctx = await companyContext(c);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return streamTurn(c, {
    companyId: ctx.company.id,
    sessionUser: ctx.access.sessionUser,
    conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
    text: readMessageText(body),
    userAgent: c.req.header("User-Agent") ?? null,
  });
});

export default routes;
