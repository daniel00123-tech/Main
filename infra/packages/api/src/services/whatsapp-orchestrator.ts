import { getUserByMobileE164, toSessionUser } from "../auth/users";
import type { Env } from "../env";
import { newId } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { executeGatewayRequest } from "./gateway";
import {
  COMPANY_KNOWLEDGE_READ_TOOL,
  COMPANY_KNOWLEDGE_SEARCH_TOOL,
  toStandardFetchPayload,
  toStandardSearchPayload,
} from "./mcp-knowledge-standard";
import { UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE, tryNormalizeE164 } from "./phone";
import { recordUsageEvent } from "./usage";
import { inspectWhatsAppAssets, outboundAiEnabled } from "./whatsapp-assets";
import {
  compactConversationPrompt,
  loadWhatsAppConversation,
  saveWhatsAppConversation,
  type WhatsAppTurn,
} from "./whatsapp-context";
import {
  aiFailureWhatsAppMessage,
  companySelectionMessage,
  formatWhatsAppReply,
  toolFailureWhatsAppMessage,
  writeIntentWhatsAppMessage,
} from "./whatsapp-format";
import { resolveWhatsAppIdentity } from "./whatsapp-identity";
import { sendWhatsAppText, type WhatsAppSendResult } from "./whatsapp-send";

export const WHATSAPP_AI_PROVIDER = "infra-gateway";
export const WHATSAPP_AI_MODEL = "company-mcp-knowledge";

const WRITE_INTENT =
  /\b(create (an? )?(invoice|bill|credit)|approve |send (the )?invoice|delete |void |allocate |raise an invoice|write to|update (the )?(invoice|bill|contact)|credit note)\b/i;
const FETCH_INTENT = /\b(find|open|read|what does|what is|tell me what|relates? to)\b/i;
const FINANCIAL_READ = /\b(sales|revenue|profit|p&l|invoices?|aged|balance|contacts?)\b/i;

const ALLOWED_WHATSAPP_TOOLS = new Set([
  "search",
  COMPANY_KNOWLEDGE_SEARCH_TOOL,
  "fetch",
  COMPANY_KNOWLEDGE_READ_TOOL,
  "database_summary",
  "system_health",
  "xero_search_invoices",
  "xero_get_organisation",
  "xero_sales_summary",
  "xero_profit_and_loss",
  "xero_get_invoice",
  "xero_search_contacts",
]);

export type WhatsAppInboundItem = {
  wamid: string;
  from: string;
  type: string;
  text: string | null;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  timestamp: string | null;
};

export type WhatsAppOrchestratorResult = {
  handled: boolean;
  duplicate: boolean;
  identityFound: boolean;
  companyId: string | null;
  userId: string | null;
  replySent: boolean;
  publicReply: string | null;
  toolName: string | null;
  interactionId: string | null;
  outcome: "unknown" | "company_selection" | "write_blocked" | "answered" | "tool_failed" | "ai_failed" | "send_failed" | "skipped";
};

export function looksLikeWriteIntent(text: string): boolean {
  return WRITE_INTENT.test(text);
}

export function parseCompanySelection(
  text: string,
  companies: Array<{ companyId: string; companyName: string }>,
): { companyId: string; companyName: string } | null {
  const trimmed = text.trim();
  const numbered = trimmed.match(/^(\d+)\.?$/);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return companies[index] ?? null;
  }
  const lower = trimmed.toLowerCase();
  const named = companies.filter((company) => company.companyName.toLowerCase() === lower);
  if (named.length === 1) return named[0]!;
  const partial = companies.filter((company) => company.companyName.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]! : null;
}

export function resolveWhatsAppCompany(input: {
  memberships: Array<{ companyId: string; companyName: string }>;
  lastCompanyId: string | null;
  pendingSelection: boolean;
  message: string;
}):
  | { status: "resolved"; companyId: string; companyName: string }
  | { status: "select"; companies: Array<{ companyId: string; companyName: string }> } {
  const memberships = input.memberships;
  if (memberships.length === 1) {
    return { status: "resolved", companyId: memberships[0]!.companyId, companyName: memberships[0]!.companyName };
  }
  if (input.pendingSelection) {
    const chosen = parseCompanySelection(input.message, memberships);
    if (chosen) return { status: "resolved", companyId: chosen.companyId, companyName: chosen.companyName };
    return { status: "select", companies: memberships };
  }
  const last = memberships.find((membership) => membership.companyId === input.lastCompanyId);
  if (last) {
    return { status: "resolved", companyId: last.companyId, companyName: last.companyName };
  }
  return { status: "select", companies: memberships };
}

export async function handleWhatsAppInboundMessage(
  env: Env,
  item: WhatsAppInboundItem,
  options?: {
    signatureValid?: boolean;
    waitUntil?: (promise: Promise<unknown>) => void;
    alreadyRecorded?: boolean;
  },
): Promise<WhatsAppOrchestratorResult> {
  const assets = inspectWhatsAppAssets(env);
  const expectedPhone = assets.phoneNumberId;
  if (!assets.ok) {
    return skipped("skipped", { identityFound: false });
  }
  if (item.phoneNumberId && item.phoneNumberId !== expectedPhone) {
    return skipped("skipped", { identityFound: false });
  }
  if (item.businessAccountId && item.businessAccountId !== assets.businessAccountId) {
    return skipped("skipped", { identityFound: false });
  }

  const claimed = options?.alreadyRecorded ? { duplicate: false } : await claimWhatsAppMessage(env, item.wamid);
  if (claimed.duplicate) {
    return {
      handled: true,
      duplicate: true,
      identityFound: false,
      companyId: null,
      userId: null,
      replySent: false,
      publicReply: null,
      toolName: null,
      interactionId: null,
      outcome: "skipped",
    };
  }

  const parsed = tryNormalizeE164(item.from);
  const sender = parsed.ok ? parsed.e164 : null;
  const identity = sender ? await resolveWhatsAppIdentity(env.DB, sender) : null;
  const found = Boolean(identity?.found);

  if (!found || !identity?.found || !sender) {
    const reply = UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE;
    const sent = await maybeSendReply(env, sender, reply);
    await recordAuditEvent(env.DB, {
      companyId: null,
      eventType: "whatsapp.inbound_unknown",
      actor: "whatsapp-channel",
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: { channel: "whatsapp", identityFound: false, trusted: Boolean(options?.signatureValid) },
    });
    return {
      handled: true,
      duplicate: false,
      identityFound: false,
      companyId: null,
      userId: null,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId: null,
      outcome: "unknown",
    };
  }

  const conversation = await loadWhatsAppConversation(env, identity.user.id);
  const companyDecision = resolveWhatsAppCompany({
    memberships: identity.memberships.map((membership) => ({
      companyId: membership.companyId,
      companyName: membership.companyName,
    })),
    lastCompanyId: conversation?.companyId ?? null,
    pendingSelection: Boolean(conversation?.pendingCompanySelection),
    message: item.text ?? "",
  });

  if (companyDecision.status === "select") {
    const reply = companySelectionMessage(companyDecision.companies);
    const sent = await maybeSendReply(env, sender, reply);
    await saveWhatsAppConversation(env, {
      userId: identity.user.id,
      companyId: null,
      pendingCompanySelection: true,
      turns: [],
    });
    await recordAuditEvent(env.DB, {
      companyId: null,
      eventType: "whatsapp.company_selection",
      actor: identity.user.email,
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: { channel: "whatsapp", identityFound: true, companyCount: companyDecision.companies.length },
    });
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: null,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId: null,
      outcome: "company_selection",
    };
  }

  const text = (item.text ?? "").trim();
  if (!text || item.type !== "text") {
    const reply = "I can answer text questions about your connected business systems. Please send a short question.";
    const sent = await maybeSendReply(env, sender, reply);
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: companyDecision.companyId,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId: null,
      outcome: "answered",
    };
  }

  if (looksLikeWriteIntent(text)) {
    const reply = writeIntentWhatsAppMessage();
    const sent = await maybeSendReply(env, sender, reply);
    await rememberTurn(env, identity.user.id, companyDecision.companyId, conversation?.turns ?? [], text, reply);
    await recordAuditEvent(env.DB, {
      companyId: companyDecision.companyId,
      eventType: "whatsapp.write_blocked",
      actor: identity.user.email,
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: { channel: "whatsapp", writeBlocked: true },
    });
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: companyDecision.companyId,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId: null,
      outcome: "write_blocked",
    };
  }

  const dbUser = await getUserByMobileE164(env.DB, sender);
  if (!dbUser || dbUser.status !== "active") {
    const reply = UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE;
    const sent = await maybeSendReply(env, sender, reply);
    return {
      handled: true,
      duplicate: false,
      identityFound: false,
      companyId: null,
      userId: null,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId: null,
      outcome: "unknown",
    };
  }

  const sessionUser = await toSessionUser(env.DB, dbUser);
  const interactionId = newId("int");
  const query = compactConversationPrompt(
    (conversation?.companyId === companyDecision.companyId ? conversation.turns : []) ?? [],
    text,
  );

  try {
    const answered = await answerWithCompanyMcp(env, {
      companyId: companyDecision.companyId,
      sessionUser,
      query,
      originalText: text,
      interactionId,
      waitUntil: options?.waitUntil,
    });

    const sent = await maybeSendReply(env, sender, answered.reply);
    await rememberTurn(
      env,
      identity.user.id,
      companyDecision.companyId,
      conversation?.companyId === companyDecision.companyId ? conversation?.turns ?? [] : [],
      text,
      answered.reply,
    );
    await recordWhatsAppChannelUsage(env, {
      companyId: companyDecision.companyId,
      userId: identity.user.id,
      actorEmail: identity.user.email,
      interactionId,
      success: answered.outcome === "answered" && sent.ok,
      durationMs: answered.latencyMs,
      toolName: answered.toolName,
      send: sent,
    });
    await recordAuditEvent(env.DB, {
      companyId: companyDecision.companyId,
      eventType: sent.ok ? "whatsapp.inbound_identified" : "whatsapp.outbound_failed",
      actor: identity.user.email,
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: {
        channel: "whatsapp",
        identityFound: true,
        companyId: companyDecision.companyId,
        toolName: answered.toolName,
        provider: WHATSAPP_AI_PROVIDER,
        model: WHATSAPP_AI_MODEL,
        sendKind: "customer_service_reply",
        cursorInRuntime: false,
      },
    });
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: companyDecision.companyId,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: answered.reply,
      toolName: answered.toolName,
      interactionId,
      outcome: sent.ok ? answered.outcome : "send_failed",
    };
  } catch {
    const reply = aiFailureWhatsAppMessage();
    const sent = await maybeSendReply(env, sender, reply);
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: companyDecision.companyId,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId,
      outcome: "ai_failed",
    };
  }
}

async function answerWithCompanyMcp(
  env: Env,
  input: {
    companyId: string;
    sessionUser: Awaited<ReturnType<typeof toSessionUser>>;
    query: string;
    originalText: string;
    interactionId: string;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<{
  reply: string;
  toolName: string;
  outcome: "answered" | "tool_failed" | "ai_failed";
  latencyMs: number;
}> {
  const started = Date.now();
  const searchTool = COMPANY_KNOWLEDGE_SEARCH_TOOL;
  if (!ALLOWED_WHATSAPP_TOOLS.has(searchTool)) {
    return { reply: toolFailureWhatsAppMessage(), toolName: searchTool, outcome: "tool_failed", latencyMs: 0 };
  }

  const search = await executeGatewayRequest(env, {
    actor: { type: "user", user: input.sessionUser },
    companyId: input.companyId,
    toolName: searchTool,
    arguments: { query: input.query, limit: 5 },
    sourceClient: "whatsapp",
    interactionId: input.interactionId,
    waitUntil: input.waitUntil,
  });

  if (search.status !== 200) {
    if (FINANCIAL_READ.test(input.originalText)) {
      const xeroTool = /\bprofit|p&l\b/i.test(input.originalText)
        ? "xero_profit_and_loss"
        : "xero_sales_summary";
      if (ALLOWED_WHATSAPP_TOOLS.has(xeroTool)) {
        const xero = await executeGatewayRequest(env, {
          actor: { type: "user", user: input.sessionUser },
          companyId: input.companyId,
          toolName: xeroTool,
          arguments: { query: input.originalText },
          sourceClient: "whatsapp",
          interactionId: input.interactionId,
          waitUntil: input.waitUntil,
        });
        if (xero.status === 200) {
          return {
            reply: formatWhatsAppReply(summariseToolResult(xero.result, input.originalText)),
            toolName: xeroTool,
            outcome: "answered",
            latencyMs: Date.now() - started,
          };
        }
      }
    }
    if (search.status >= 500) {
      return {
        reply: aiFailureWhatsAppMessage(),
        toolName: searchTool,
        outcome: "ai_failed",
        latencyMs: Date.now() - started,
      };
    }
    return {
      reply: toolFailureWhatsAppMessage(),
      toolName: searchTool,
      outcome: "tool_failed",
      latencyMs: Date.now() - started,
    };
  }

  const hits = toStandardSearchPayload(search.result).results;
  let body = formatSearchHits(hits, input.originalText);

  if (FETCH_INTENT.test(input.originalText) && hits[0]?.id && ALLOWED_WHATSAPP_TOOLS.has(COMPANY_KNOWLEDGE_READ_TOOL)) {
    const fetched = await executeGatewayRequest(env, {
      actor: { type: "user", user: input.sessionUser },
      companyId: input.companyId,
      toolName: COMPANY_KNOWLEDGE_READ_TOOL,
      arguments: { documentRef: hits[0].id, id: hits[0].id },
      sourceClient: "whatsapp",
      interactionId: input.interactionId,
      waitUntil: input.waitUntil,
    });
    if (fetched.status === 200) {
      const doc = toStandardFetchPayload(fetched.result, hits[0].id);
      const excerpt = formatWhatsAppReply(
        `${doc.title}\n\n${doc.text || hits[0].snippet || "This document is in your connected business systems."}`,
      );
      return {
        reply: excerpt,
        toolName: COMPANY_KNOWLEDGE_READ_TOOL,
        outcome: "answered",
        latencyMs: Date.now() - started,
      };
    }
  }

  if (!hits.length && FINANCIAL_READ.test(input.originalText)) {
    const xeroTool = "xero_sales_summary";
    const xero = await executeGatewayRequest(env, {
      actor: { type: "user", user: input.sessionUser },
      companyId: input.companyId,
      toolName: xeroTool,
      arguments: { query: input.originalText },
      sourceClient: "whatsapp",
      interactionId: input.interactionId,
      waitUntil: input.waitUntil,
    });
    if (xero.status === 200) {
      body = formatWhatsAppReply(summariseToolResult(xero.result, input.originalText));
      return { reply: body, toolName: xeroTool, outcome: "answered", latencyMs: Date.now() - started };
    }
  }

  return {
    reply: formatWhatsAppReply(body),
    toolName: searchTool,
    outcome: "answered",
    latencyMs: Date.now() - started,
  };
}

function formatSearchHits(
  hits: Array<{ title: string; snippet?: string }>,
  question: string,
): string {
  if (!hits.length) {
    return "I could not find a matching document in your connected business systems.";
  }
  const top = hits[0]!;
  const extras = hits.slice(1, 3).map((hit) => `• ${hit.title}`);
  const head = top.snippet
    ? `${top.title}\n\n${top.snippet}`
    : `${top.title} looks like the closest match for “${question.slice(0, 80)}”.`;
  return extras.length ? `${head}\n\nAlso found:\n${extras.join("\n")}` : head;
}

function summariseToolResult(result: unknown, question: string): string {
  if (result == null) {
    return `I looked this up for “${question.slice(0, 80)}” but did not get a usable summary.`;
  }
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    const summary =
      (typeof record.summary === "string" && record.summary) ||
      (typeof record.text === "string" && record.text) ||
      (typeof record.message === "string" && record.message);
    if (summary) return summary;
  }
  return "I found matching business data. Ask a more specific follow-up if you need a narrower figure.";
}

async function maybeSendReply(
  env: Env,
  toE164: string | null,
  body: string,
): Promise<WhatsAppSendResult> {
  if (!toE164 || !outboundAiEnabled(env)) {
    return {
      ok: false,
      kind: "customer_service_reply",
      error: "Outbound WhatsApp is not enabled",
      retryable: false,
      attempts: 0,
    };
  }
  return sendWhatsAppText(env, {
    toE164,
    body,
    inCustomerServiceWindow: true,
  });
}

async function rememberTurn(
  env: Env,
  userId: string,
  companyId: string,
  prior: WhatsAppTurn[],
  userText: string,
  assistantText: string,
): Promise<void> {
  await saveWhatsAppConversation(env, {
    userId,
    companyId,
    pendingCompanySelection: false,
    turns: [
      ...prior,
      { role: "user", text: userText.slice(0, 500) },
      { role: "assistant", text: assistantText.slice(0, 500) },
    ],
  });
}

async function claimWhatsAppMessage(env: Env, wamid: string): Promise<{ duplicate: boolean }> {
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM whatsapp_inbound_events WHERE wamid = ? AND processed = 1 LIMIT 1`,
    )
      .bind(wamid)
      .first<{ id: string }>();
    return { duplicate: Boolean(existing) };
  } catch {
    return { duplicate: false };
  }
}

async function recordWhatsAppChannelUsage(
  env: Env,
  input: {
    companyId: string;
    userId: string;
    actorEmail: string;
    interactionId: string;
    success: boolean;
    durationMs: number;
    toolName: string | null;
    send: WhatsAppSendResult;
  },
): Promise<void> {
  await recordUsageEvent(env.DB, {
    companyId: input.companyId,
    userId: input.userId,
    actorEmail: input.actorEmail,
    resourceType: "whatsapp",
    resourceId: "outbound_text",
    toolName: "whatsapp.send",
    action: "whatsapp.reply",
    success: input.send.ok,
    durationMs: input.durationMs,
    sourceClient: "whatsapp",
    requestId: `wa_send_${input.interactionId}`,
    interactionId: input.interactionId,
    charge: {
      billable: false,
      customerChargeCents: null,
      calculatedSellingCents: null,
      minimumChargeApplied: false,
      underlyingCostCents: null,
      underlyingCostMicros: null,
      estimatedCostMicros: null,
      costBasis: "unknown",
      targetMarginBps: null,
      actualMarginBps: null,
      grossProfitCents: null,
      pricingLabel: "whatsapp_provider_cost_unknown",
      pricingRuleId: null,
      rateCardId: null,
      rateCardVersion: null,
      isTestConfig: false,
    },
    metadata: {
      channel: "whatsapp",
      aiProvider: WHATSAPP_AI_PROVIDER,
      aiModel: WHATSAPP_AI_MODEL,
      toolName: input.toolName,
      whatsappProviderCost: "unknown",
      modelProviderCost: "unknown",
      sendKind: "customer_service_reply",
      sendAttempts: input.send.attempts,
      cursorInRuntime: false,
    },
  }).catch(() => undefined);
}

function skipped(
  outcome: WhatsAppOrchestratorResult["outcome"],
  extra: { identityFound: boolean },
): WhatsAppOrchestratorResult {
  return {
    handled: false,
    duplicate: false,
    identityFound: extra.identityFound,
    companyId: null,
    userId: null,
    replySent: false,
    publicReply: null,
    toolName: null,
    interactionId: null,
    outcome,
  };
}
