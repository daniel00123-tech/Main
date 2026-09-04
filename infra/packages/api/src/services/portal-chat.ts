import type { SessionUser } from "../auth/session";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
import { newId, nowIso } from "../db/mappers";
import type { Env } from "../env";
import { userHasCompanyAccess } from "../permissions/service";
import { getCompanyById } from "./control-plane";
import {
  buildConversationState,
  buildAllowedToolCatalogue,
  runIntelligenceTurn,
  type IntelligenceCompleter,
  type IntelligenceDocumentRef,
  type IntelligenceTurnResult,
} from "./intelligence/index";
import { collectQualityFlags } from "./intelligence/quality.js";
import { listConnectedConnectorIds } from "./whatsapp-capabilities";
import { createPortalChatRuntime, type PortalChatGatewayFn } from "./portal-chat-runtime";
import { publicToolErrorMessage } from "./public-errors";
import {
  classifyReadTerminal,
  isGenericRetryCopy,
  synthesizeFromToolCalls,
} from "./intelligence/verbalise-business.js";
import { displayConversationTitle, messagePreview } from "@infra/shared";
import {
  classifyElTraffic,
  isLiveElBillingEnv,
  settleElCustomerRequest,
  shouldChargeElCustomerRequest,
} from "./el-customer-billing";
import { scheduleDailyImprovementCapture } from "./daily-improvement";
import {
  emptyPortalChatContext,
  titleFromUserText,
  type PortalChatContext,
  type PortalChatConversation,
  type PortalChatConversationSummary,
  type PortalChatMessage,
  type PortalChatMessageMetadata,
  type PortalChatStatusEvent,
  type PortalChatTurnResult,
} from "./portal-chat-types";

export {
  PORTAL_CHAT_SOURCE_CLIENT,
  emptyPortalChatContext,
  titleFromUserText,
  toolStatusLabel,
} from "./portal-chat-types";
export type {
  PortalChatContext,
  PortalChatConversation,
  PortalChatConversationSummary,
  PortalChatMessage,
  PortalChatStatusEvent,
  PortalChatTurnResult,
} from "./portal-chat-types";

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS portal_conversations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_portal_conversations_user_company
  ON portal_conversations (company_id, user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS portal_conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_portal_messages_conversation
  ON portal_conversation_messages (conversation_id, created_at)`,
];

let schemaReady = false;

export async function ensurePortalChatSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  for (const sql of SCHEMA_SQL) {
    await db.prepare(sql).run();
  }
  schemaReady = true;
}

export function resetPortalChatSchemaCache(): void {
  schemaReady = false;
}

export type PortalChatAccess =
  | { ok: true; sessionUser: SessionUser; role: string }
  | { ok: false; status: 403; error: string };

export async function resolvePortalChatAccess(
  db: D1Database,
  sessionUser: SessionUser,
  companyId: string,
): Promise<PortalChatAccess> {
  const live = await loadLiveCompanyActor(db, sessionUser.userId, companyId);
  if (live) {
    if (!live.active) {
      return { ok: false, status: 403, error: live.denyReason ?? "Access to this company is denied" };
    }
    return { ok: true, sessionUser: liveActorToSessionUser(live), role: live.role };
  }
  if (sessionUser.isPlatformAdmin) {
    return { ok: true, sessionUser, role: "company_admin" };
  }
  if (!userHasCompanyAccess(sessionUser, companyId)) {
    return { ok: false, status: 403, error: "Access to this company is denied" };
  }
  const membership = sessionUser.memberships.find((row) => row.companyId === companyId);
  return { ok: true, sessionUser, role: membership?.role ?? "office_staff" };
}

export async function listPortalConversations(
  db: D1Database,
  companyId: string,
  userId: string,
  limit = 40,
): Promise<PortalChatConversationSummary[]> {
  await ensurePortalChatSchema(db);
  const rows = await db
    .prepare(
      `SELECT id, company_id, user_id, title, created_at, updated_at
       FROM portal_conversations
       WHERE company_id = ? AND user_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(companyId, userId, Math.min(Math.max(limit, 1), 80))
    .all<Record<string, unknown>>();
  const summaries = (rows.results ?? []).map(rowToSummary);
  const visible: PortalChatConversationSummary[] = [];
  for (const summary of summaries) {
    const messages = await listPortalMessages(db, summary.id, companyId);
    if (messages.length === 0) continue;
    const firstUser = messages.find((message) => message.role === "user");
    const last = messages[messages.length - 1];
    visible.push({
      ...summary,
      title: displayConversationTitle(summary.title, firstUser?.content),
      lastMessagePreview: messagePreview(last?.content) || null,
      lastMessageAt: last?.createdAt ?? summary.updatedAt,
      messageCount: messages.length,
    });
  }
  return visible;
}

export async function createPortalConversation(
  db: D1Database,
  input: { companyId: string; userId: string; title?: string },
): Promise<PortalChatConversationSummary> {
  await ensurePortalChatSchema(db);
  const now = nowIso();
  const id = newId("pchat");
  const title = (input.title ?? "New chat").trim().slice(0, 80) || "New chat";
  await db
    .prepare(
      `INSERT INTO portal_conversations (id, company_id, user_id, title, context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    )
    .bind(id, input.companyId, input.userId, title, now, now)
    .run();
  return { id, companyId: input.companyId, userId: input.userId, title, createdAt: now, updatedAt: now };
}

export async function getPortalConversation(
  db: D1Database,
  input: { conversationId: string; companyId: string; userId: string },
): Promise<PortalChatConversation | null> {
  await ensurePortalChatSchema(db);
  const row = await db
    .prepare(
      `SELECT id, company_id, user_id, title, context_json, created_at, updated_at
       FROM portal_conversations
       WHERE id = ? AND company_id = ? AND user_id = ?
       LIMIT 1`,
    )
    .bind(input.conversationId, input.companyId, input.userId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return { ...rowToSummary(row), context: parseContext(row.context_json), messages: await listPortalMessages(db, input.conversationId, input.companyId) };
}

export async function renamePortalConversation(
  db: D1Database,
  input: { conversationId: string; companyId: string; userId: string; title: string },
): Promise<PortalChatConversationSummary | null> {
  await ensurePortalChatSchema(db);
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!title) return null;
  const existing = await getPortalConversation(db, input);
  if (!existing) return null;
  const now = nowIso();
  await db
    .prepare(
      `UPDATE portal_conversations SET title = ?, updated_at = ? WHERE id = ? AND company_id = ? AND user_id = ?`,
    )
    .bind(title, now, input.conversationId, input.companyId, input.userId)
    .run();
  return { ...rowToSummary(existing), title, updatedAt: now };
}

export async function sendPortalChatMessage(
  env: Env,
  input: {
    companyId: string;
    sessionUser: SessionUser;
    conversationId?: string | null;
    text: string;
    waitUntil?: (promise: Promise<unknown>) => void;
    onStatus?: (status: PortalChatStatusEvent) => void;
    completer?: IntelligenceCompleter;
    executeGateway?: PortalChatGatewayFn;
    connectors?: string[];
  },
): Promise<PortalChatTurnResult> {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new PortalChatError("Message cannot be empty", 400);
  if (text.length > 4_000) throw new PortalChatError("Message is too long", 400);

  await ensurePortalChatSchema(env.DB);
  let createdConversation = false;
  let conversationId = input.conversationId?.trim() || "";
  if (!conversationId) {
    const created = await createPortalConversation(env.DB, {
      companyId: input.companyId,
      userId: input.sessionUser.userId,
      title: titleFromUserText(text),
    });
    conversationId = created.id;
    createdConversation = true;
  }

  const conversation = await getPortalConversation(env.DB, {
    conversationId,
    companyId: input.companyId,
    userId: input.sessionUser.userId,
  });
  if (!conversation) throw new PortalChatError("Conversation not found", 404);

  const userMessage = await insertMessage(env.DB, {
    conversationId,
    companyId: input.companyId,
    userId: input.sessionUser.userId,
    role: "user",
    content: text,
    metadata: {},
  });

  const interactionId = newId("pint");
  const trafficClass = classifyElTraffic({
    sourceClient: "portal_chat",
    actorEmail: input.sessionUser.email,
  });
  if (isLiveElBillingEnv(env) && shouldChargeElCustomerRequest(input.companyId, trafficClass)) {
    const settled = await settleElCustomerRequest(env.DB, {
      companyId: input.companyId,
      requestId: interactionId,
      userId: input.sessionUser.userId,
      actorEmail: input.sessionUser.email,
      sourceClient: "portal_chat",
      channel: "portal_chat",
      conversationId,
      trafficClass,
      outcome: "accepted",
      summary: text.slice(0, 120),
    });
    if (settled.insufficientCredit) {
      throw new PortalChatError(
        "Your INFRA credit balance is empty. Add credit to continue.",
        402,
      );
    }
  }
  const connectors = input.connectors ?? (await listConnectedConnectorIds(env, input.companyId));
  const company = await getCompanyById(env.DB, input.companyId).catch(() => null);
  const membership = input.sessionUser.memberships.find((row) => row.companyId === input.companyId);
  const recentTurns = conversation.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-10)
    .map((message) => ({ role: message.role, text: message.content }));

  const state = buildConversationState({
    userText: text,
    currentDocument: conversation.context.currentDocument,
    entities: conversation.context.recentDocuments,
    recentTurns,
    companyId: input.companyId,
    companyName: company?.name ?? null,
    role: membership?.role ?? null,
    connectors,
    permittedTools: buildAllowedToolCatalogue({
      role: membership?.role ?? null,
      companyId: input.companyId,
      connectors,
      channel: "portal",
    }),
    lastToolName: conversation.context.lastToolName,
    lastToolSummary: conversation.context.lastToolSummary,
    recentDocuments: conversation.context.recentDocuments,
    currentScope: conversation.context.currentScope,
    currentBusinessSystem: conversation.context.currentBusinessSystem,
    lastSuccessfulTool: conversation.context.lastSuccessfulTool,
    lastAnswerTopic: conversation.context.lastAnswerTopic,
    lastUserIntent: conversation.context.lastUserIntent,
    lastAnswerText: conversation.context.lastAnswerText,
    recentEvidence: conversation.context.recentEvidence,
  });

  const runtime = createPortalChatRuntime(env, {
    companyId: input.companyId,
    sessionUser: input.sessionUser,
    interactionId,
    context: conversation.context,
    connectors,
    waitUntil: input.waitUntil,
    onStatus: input.onStatus,
    executeGateway: input.executeGateway,
  });

  let result = await runIntelligenceTurn({
    env,
    text,
    state,
    runtime,
    channel: "portal",
    completer: input.completer,
    waitUntil: input.waitUntil,
  });
  result = {
    ...result,
    qualityFlags: collectQualityFlags({
      result,
      userCorrection: false,
      expectedStayOnDocument: result.scope === "CURRENT_DOCUMENT" && Boolean(conversation.context.currentDocument),
      scope: result.scope,
      connectors,
      scopeSwitch: Boolean(result.scope && result.scope !== "CURRENT_DOCUMENT" && conversation.context.currentDocument),
      rephrase: result.lastUserIntent === "rephrase",
      previousAnswer: conversation.context.lastAnswerText,
    }),
  };

  const reply = polishPortalReply(result, text);
  const metadata = metadataFromTurn(result);
  const assistantMessage = await insertMessage(env.DB, {
    conversationId,
    companyId: input.companyId,
    userId: input.sessionUser.userId,
    role: "assistant",
    content: reply,
    metadata,
  });

  scheduleDailyImprovementCapture(
    env,
    input.waitUntil,
    {
      interactionId,
      companyId: input.companyId,
      userId: input.sessionUser.userId,
      role: membership?.role ?? null,
      channel: "portal_chat",
      conversationId,
      userMessage: text,
      assistantAnswer: reply,
      toolsRequested: result.toolCalls.map((call) => call.name),
      toolsExecuted: result.toolCalls.filter((call) => call.ok).map((call) => call.name),
      availableCapabilities: state.permittedTools ?? [],
      terminalState: result.terminal ?? result.kind,
      provider: result.provider ?? null,
      model: result.model ?? null,
      providerMode: result.brainMode ?? null,
      trafficClass,
      sourceClient: "portal_chat",
      customerChargeCents: shouldChargeElCustomerRequest(input.companyId, trafficClass) ? 3 : 0,
    },
  );

  const nextContext = contextFromTurn(conversation.context, result, reply);
  const nextTitle =
    conversation.title === "New chat" || !conversation.title.trim() ? titleFromUserText(text) : conversation.title;
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE portal_conversations SET context_json = ?, title = ?, updated_at = ? WHERE id = ? AND company_id = ? AND user_id = ?`,
  )
    .bind(JSON.stringify(nextContext), nextTitle, now, conversationId, input.companyId, input.sessionUser.userId)
    .run();

  return {
    conversation: {
      id: conversationId,
      companyId: input.companyId,
      userId: input.sessionUser.userId,
      title: nextTitle,
      createdAt: conversation.createdAt,
      updatedAt: now,
    },
    userMessage,
    assistantMessage,
    createdConversation,
  };
}

export class PortalChatError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PortalChatError";
    this.status = status;
  }
}

export function polishPortalReply(result: IntelligenceTurnResult, question: string): string {
  const deniedCall = result.toolCalls.find((call) => isPermissionDenial(call.error, call.data));
  if (deniedCall) {
    const data = isRecord(deniedCall.data) ? deniedCall.data : {};
    const raw = String(deniedCall.error ?? data.error ?? result.text ?? "");
    const status = Number(data.status ?? 403);
    return publicToolErrorMessage(status, raw).message;
  }
  let text = (result.text ?? "").trim();
  if (isGenericRetryCopy(text) && result.toolCalls.length > 0) {
    text = synthesizeFromToolCalls(result.toolCalls, question);
  }
  if (!text) {
    if (result.toolCalls.length > 0) text = synthesizeFromToolCalls(result.toolCalls, question);
    else if (result.kind === "failed") return "INFRA couldn’t process that request just now. Please try again.";
    else text = "I'm here — what would help?";
  }
  const sourceUrl = result.currentDocument?.url ?? null;
  const wantsSource =
    result.citeSource ||
    /\b(where did you get|source (url|link)|send me the (link|url)|what('?s| is) the (url|link))\b/i.test(question);
  if (sourceUrl && wantsSource && !/https?:\/\//i.test(text)) {
    text = `${text}\n${sourceUrl}`;
  }
  return text;
}

export { classifyReadTerminal, isGenericRetryCopy } from "./intelligence/verbalise-business.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isPermissionDenial(error?: string | null, data?: unknown): boolean {
  const record = isRecord(data) ? data : {};
  if (
    record.accessOutcome === "permission_denied" ||
    record.denied === true ||
    record.result === "permission_denied" ||
    record.billingStatus === "denied"
  ) {
    return true;
  }
  const status = Number(record.status ?? record.httpStatus ?? 0);
  if (status === 403) return true;
  const err = [error, record.error, record.code, record.reason]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /permission_denied|user_not_authorised|not allowed for your role|office staff permissions|your current permissions don’t allow|your current permissions don't allow/i.test(
    err,
  );
}

function metadataFromTurn(result: IntelligenceTurnResult): PortalChatMessageMetadata {
  const sources: PortalChatMessageMetadata["sources"] = [];
  if (result.currentDocument) {
    sources.push({
      id: result.currentDocument.id,
      title: result.currentDocument.title,
      url: result.currentDocument.url ?? null,
    });
  }
  return {
    kind: result.kind,
    confidence: result.confidence,
    scope: result.scope ?? null,
    toolNames: result.toolCalls.map((call) => call.name),
    sources,
    permissionDenied: result.toolCalls.some((call) => isPermissionDenial(call.error, call.data)),
    controlledAction: result.kind === "controlled_action",
    citeSource: result.citeSource,
    terminal: result.terminal ?? classifyReadTerminal(result.toolCalls, result.text, result.kind),
    provider: result.provider,
    model: result.model,
    brainMode: result.brainMode ?? null,
    shadowProvider: result.shadowEval?.provider ?? null,
    shadowModel: result.shadowEval?.model ?? null,
    shadowLatencyMs: result.shadowEval?.latencyMs ?? null,
    shadowPromptTokens: result.shadowEval?.promptTokens ?? null,
    shadowCompletionTokens: result.shadowEval?.completionTokens ?? null,
    shadowToolProposal: result.shadowEval?.toolProposal ?? [],
  };
}

function contextFromTurn(
  prior: PortalChatContext,
  result: IntelligenceTurnResult,
  reply: string,
): PortalChatContext {
  const currentDocument = result.currentDocument ?? prior.currentDocument ?? null;
  const recentDocuments = mergeRecentDocuments(prior.recentDocuments, currentDocument);
  return {
    currentDocument,
    recentDocuments,
    lastToolName: result.toolCalls.at(-1)?.name ?? prior.lastToolName ?? null,
    lastToolSummary: reply.slice(0, 240),
    currentScope: result.scope ?? prior.currentScope ?? null,
    currentBusinessSystem:
      result.scope === "BUSINESS_SYSTEM"
        ? result.lastAnswerTopic === "email"
          ? "email"
          : "xero"
        : result.scope === "SYSTEM_META" || result.scope === "GENERAL_CONVERSATION"
          ? prior.currentBusinessSystem ?? null
          : prior.currentBusinessSystem ?? null,
    lastSuccessfulTool: result.toolCalls.find((call) => call.ok)?.name ?? prior.lastSuccessfulTool ?? null,
    lastAnswerTopic: result.lastAnswerTopic ?? prior.lastAnswerTopic ?? null,
    lastUserIntent: result.lastUserIntent ?? prior.lastUserIntent ?? null,
    lastAnswerText: reply.slice(0, 1_200),
    recentEvidence: result.recentEvidence ?? prior.recentEvidence ?? null,
  };
}

function mergeRecentDocuments(
  prior: IntelligenceDocumentRef[],
  current: IntelligenceDocumentRef | null,
): IntelligenceDocumentRef[] {
  const next = [...prior];
  if (current && !next.some((doc) => doc.id === current.id)) next.unshift(current);
  return next.slice(0, 6);
}

async function listPortalMessages(db: D1Database, conversationId: string, companyId: string): Promise<PortalChatMessage[]> {
  const rows = await db
    .prepare(
      `SELECT id, conversation_id, company_id, user_id, role, content, metadata_json, created_at
       FROM portal_conversation_messages
       WHERE conversation_id = ? AND company_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(conversationId, companyId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToMessage);
}

async function insertMessage(
  db: D1Database,
  input: {
    conversationId: string;
    companyId: string;
    userId: string;
    role: "user" | "assistant";
    content: string;
    metadata: PortalChatMessageMetadata;
  },
): Promise<PortalChatMessage> {
  const now = nowIso();
  const id = newId(input.role === "user" ? "pcu" : "pca");
  await db
    .prepare(
      `INSERT INTO portal_conversation_messages
       (id, conversation_id, company_id, user_id, role, content, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.conversationId, input.companyId, input.userId, input.role, input.content, JSON.stringify(input.metadata ?? {}), now)
    .run();
  return {
    id,
    conversationId: input.conversationId,
    companyId: input.companyId,
    userId: input.userId,
    role: input.role,
    content: input.content,
    createdAt: now,
    metadata: input.metadata,
  };
}

function rowToSummary(row: Record<string, unknown> | PortalChatConversationSummary): PortalChatConversationSummary {
  return {
    id: String(row.id),
    companyId: String("companyId" in row && row.companyId ? row.companyId : (row as Record<string, unknown>).company_id ?? ""),
    userId: String("userId" in row && row.userId ? row.userId : (row as Record<string, unknown>).user_id ?? ""),
    title: String(row.title ?? "New chat"),
    createdAt: String("createdAt" in row && row.createdAt ? row.createdAt : (row as Record<string, unknown>).created_at ?? ""),
    updatedAt: String("updatedAt" in row && row.updatedAt ? row.updatedAt : (row as Record<string, unknown>).updated_at ?? ""),
  };
}

function rowToMessage(row: Record<string, unknown>): PortalChatMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    companyId: String(row.company_id),
    userId: String(row.user_id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
    createdAt: String(row.created_at ?? ""),
    metadata: parseJson(row.metadata_json),
  };
}

function parseContext(raw: unknown): PortalChatContext {
  const parsed = parseJson(raw);
  const current = asDocument(parsed.currentDocument);
  const recent = Array.isArray(parsed.recentDocuments)
    ? parsed.recentDocuments.map(asDocument).filter((doc): doc is IntelligenceDocumentRef => Boolean(doc))
    : [];
  return {
    currentDocument: current,
    recentDocuments: recent,
    lastToolName: typeof parsed.lastToolName === "string" ? parsed.lastToolName : null,
    lastToolSummary: typeof parsed.lastToolSummary === "string" ? parsed.lastToolSummary : null,
    currentScope: typeof parsed.currentScope === "string" ? (parsed.currentScope as PortalChatContext["currentScope"]) : null,
    currentBusinessSystem: typeof parsed.currentBusinessSystem === "string" ? parsed.currentBusinessSystem : null,
    lastSuccessfulTool: typeof parsed.lastSuccessfulTool === "string" ? parsed.lastSuccessfulTool : null,
    lastAnswerTopic: typeof parsed.lastAnswerTopic === "string" ? parsed.lastAnswerTopic : null,
    lastUserIntent: typeof parsed.lastUserIntent === "string" ? parsed.lastUserIntent : null,
    lastAnswerText: typeof parsed.lastAnswerText === "string" ? parsed.lastAnswerText : null,
    recentEvidence:
      parsed.recentEvidence && typeof parsed.recentEvidence === "object"
        ? (parsed.recentEvidence as PortalChatContext["recentEvidence"])
        : null,
  };
}

function asDocument(value: unknown): IntelligenceDocumentRef | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!row.id || !row.title) return null;
  return { id: String(row.id), title: String(row.title), url: row.url ? String(row.url) : null, source: row.source ? String(row.source) : null };
}

function parseJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw || "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
