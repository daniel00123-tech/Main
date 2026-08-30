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
import { scheduleQualityAudit } from "./quality-auditor";
import { resolveActiveWhatsAppRuntime } from "./quality-loop";
import { DEFAULT_QUALITY_RUNTIME } from "./quality-loop/runtime-config";
import type { QualityRuntimeConfig } from "./quality-loop/types";
import { recordUsageEvent } from "./usage";
import { inspectWhatsAppAssets, outboundAiEnabled } from "./whatsapp-assets";
import { capabilityReplyForCompany, formatPricingCapabilityReply, listConnectedCapabilityLabels, listConnectedConnectorIds } from "./whatsapp-capabilities";
import {
  loadWhatsAppConversation,
  saveWhatsAppConversation,
  type WhatsAppTurn,
} from "./whatsapp-context";
import {
  documentEntityFromHit,
  emptyEntityMemory,
  inferEntitiesFromTurns,
  mergeEntityMemory,
  recentDocumentTitles,
  type WhatsAppEntityMemory,
} from "./whatsapp-entities";
import { isWhatsAppTerminalState, stampWhatsAppLifecycle, terminalStateForOutcome } from "./whatsapp-lifecycle";
import {
  FETCH_TIMEOUT_MS,
  FETCH_TOP_LIMIT,
  KNOWLEDGE_SEARCH_TIMEOUT_MS,
  MCP_TIMEOUT_MS,
  SEARCH_CANDIDATE_LIMIT,
  SYNTHESIS_TIMEOUT_MS,
  withBoundedTimeout,
} from "./whatsapp-timeouts";
import {
  knowledgeCircuitOpen,
  recordKnowledgeSuccess,
  recordKnowledgeTimeout,
} from "./whatsapp-knowledge-breaker";
import { lookupKnowledgeSourceUrl } from "./whatsapp-source-urls";
import { raceWithWhatsAppWatchdog } from "./whatsapp-watchdog";
import { guidanceInfluenceNote, guidanceSearchQuery, isGuidanceHit } from "./whatsapp-guidance";
import { planWhatsAppTurn, type WhatsAppPlan } from "./whatsapp-plan";
import {
  draftFromMemory,
  memoryFactReply,
  priceAdviceReply,
  sourceAttributionReply,
  sourceLinkReply,
  withOptionalSource,
} from "./whatsapp-synthesize";
import {
  compressDocumentAnswer,
  compressSearchAnswer,
  compressToolResult,
} from "./whatsapp-compress";
import { conversationalReply } from "./whatsapp-conversation";
import {
  aiFailureWhatsAppMessage,
  companySelectionMessage,
  formatWhatsAppReply,
  noResultWhatsAppMessage,
  permissionBlockedWhatsAppMessage,
  timeoutWhatsAppMessage,
  toolFailureWhatsAppMessage,
  writeIntentWhatsAppMessage,
} from "./whatsapp-format";
import { resolveWhatsAppIdentity } from "./whatsapp-identity";
import {
  classifyWhatsAppIntent,
  focusSearchTerms,
  isCheapConversationalIntent,
  looksLikeWriteIntent as looksLikeWriteIntentFromClassifier,
  needsToolWork,
  softenSearchQuery,
  type WhatsAppIntent,
} from "./whatsapp-intent";
import {
  createWhatsAppLatencyMarks,
  DELAY_NOTICE_MS,
  PROGRESS_AFTER_MS,
  summariseWhatsAppLatency,
} from "./whatsapp-latency";
import {
  sendWhatsAppInteractiveButtons,
  sendWhatsAppInteractiveList,
  sendWhatsAppReadStatus,
  sendWhatsAppText,
  sendWhatsAppTypingIndicator,
  type WhatsAppSendResult,
} from "./whatsapp-send";
import {
  COMBINED_GREETING_DOCUMENT_REPLY,
  instantLocalReply,
  isGenericDocumentAsk,
  isInstantLocalTurn,
  maybeCoalesceBurst,
} from "./whatsapp-realtime";
import { sendFirstResponseFailsafe } from "./whatsapp-fast-lane";
import { acquireWhatsAppChatLock, releaseWhatsAppChatLock } from "./whatsapp-chat-lock";
import { scheduleStuckTurnWatch } from "./whatsapp-reaper";
import { TYPING_MAX_REFRESHES } from "./whatsapp-latency";
import {
  listRowsFromCompanies,
  mapButtonToUserText,
  shouldAttachButtons,
  suggestionButtons,
  type WhatsAppReplyButton,
} from "./whatsapp-buttons";
import { downloadWhatsAppMedia } from "./whatsapp-media";
import { applyCustomerTone, UNSUPPORTED_BUTTON, VOICE_ACK, VOICE_NOT_CONFIGURED, VOICE_UNCLEAR } from "./whatsapp-tone";
import { transcribeWhatsAppAudio } from "./whatsapp-transcribe";
import type { WhatsAppParsedInbound } from "./whatsapp-webhook";

export const WHATSAPP_AI_PROVIDER = "infra-gateway";
export const WHATSAPP_AI_MODEL = "company-mcp-knowledge";

const FETCH_INTENT =
  /\b(find|open|read|what does|what is|tell me what|relates? to|summarise|summarize|full detail|give me the full)\b/i;
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
  "xero_list_overdue_invoices",
  "xero_aged_receivables",
]);

export type WhatsAppInboundItem = WhatsAppParsedInbound;

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
  outcome:
    | "unknown"
    | "company_selection"
    | "write_blocked"
    | "answered"
    | "clarification_requested"
    | "tool_failed"
    | "ai_failed"
    | "send_failed"
    | "skipped";
  intent?: string | null;
  acknowledgementSent?: boolean;
  planAction?: string | null;
  inputKind?: "text" | "voice" | "button";
  buttonsSent?: number;
};

export function looksLikeWriteIntent(text: string): boolean {
  return looksLikeWriteIntentFromClassifier(text);
}

export function parseCompanySelection(
  text: string,
  companies: Array<{ companyId: string; companyName: string }>,
): { companyId: string; companyName: string } | null {
  const trimmed = text.trim();
  const byId = companies.find((company) => company.companyId === trimmed);
  if (byId) return byId;
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
    coalesceMs?: number;
    simulateMcpTimeout?: boolean;
    inboundReceivedAt?: number;
  },
): Promise<WhatsAppOrchestratorResult> {
  const marks = createWhatsAppLatencyMarks();
  marks.inboundReceivedAt = options?.inboundReceivedAt ?? Date.now();
  marks.webhookReceivedAt = marks.inboundReceivedAt;
  const shared = { sender: null as string | null };
  try {
    return await handleWhatsAppInboundMessageInner(env, item, options, marks, shared);
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        service: "infra-api",
        event: "whatsapp.inbound_unhandled",
        wamid: item.wamid,
        message: err instanceof Error ? err.message : "unhandled inbound exception",
      }),
    );
    const reply = aiFailureWhatsAppMessage();
    const sent = await maybeSendReply(env, shared.sender, reply).catch(() => ({
      ok: false as const,
      kind: "customer_service_reply" as const,
      error: "send_failed",
      retryable: false,
      attempts: 0,
      httpStatus: null,
      rawAccepted: false as const,
    }));
    const now = new Date().toISOString();
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "failed_notified",
      terminal: "failed_notified",
      replySentAt: now,
      firstVisibleAt: now,
      lastError: "unhandled_exception",
      finalSendOk: sent.ok ? 1 : 0,
    });
    return {
      handled: true,
      duplicate: false,
      identityFound: Boolean(shared.sender),
      companyId: null,
      userId: null,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId: null,
      outcome: "ai_failed",
    };
  }
}

async function handleWhatsAppInboundMessageInner(
  env: Env,
  item: WhatsAppInboundItem,
  options: {
    signatureValid?: boolean;
    waitUntil?: (promise: Promise<unknown>) => void;
    alreadyRecorded?: boolean;
    coalesceMs?: number;
    simulateMcpTimeout?: boolean;
    inboundReceivedAt?: number;
  } | undefined,
  marks: ReturnType<typeof createWhatsAppLatencyMarks>,
  shared: { sender: string | null },
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
  const alreadyVisible = await inboundAlreadyTerminal(env, item.wamid);
  if (alreadyVisible) {
    return {
      handled: true,
      duplicate: true,
      identityFound: true,
      companyId: null,
      userId: null,
      replySent: true,
      publicReply: null,
      toolName: null,
      interactionId: null,
      outcome: "skipped",
    };
  }

  const parsed = tryNormalizeE164(item.from);
  const sender = parsed.ok ? parsed.e164 : null;
  shared.sender = sender;
  const identity = sender ? await resolveWhatsAppIdentity(env.DB, sender) : null;
  const found = Boolean(identity?.found);
  marks.validatedAt = Date.now();
  marks.identityResolvedAt = Date.now();

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

  const previewText = (item.text ?? "").trim();
  const instantPreview = Boolean(previewText && isInstantLocalTurn(previewText) && !item.mediaId);
  const lock = await acquireWhatsAppChatLock(env, {
    chatKey: sender,
    wamid: item.wamid,
    failOpen: instantPreview,
  });
  let conversation: Awaited<ReturnType<typeof loadWhatsAppConversation>> = null;
  try {
    if (!instantPreview) {
      conversation = await loadWhatsAppConversation(env, identity.user.id);
    }
  } catch {
    conversation = null;
  }
  const nowIso = () => new Date().toISOString();
  if (!lock.acquired && !lock.failOpen) {
    await stampWhatsAppLifecycle(env, item.wamid, { lastError: "chat_lock_held_failopen" });
  }
  try {
  await stampWhatsAppLifecycle(env, item.wamid, {
    state: "validated",
    validatedAt: nowIso(),
    identityResolvedAt: nowIso(),
    identityFound: 1,
    userId: identity.user.id,
    senderE164: sender,
    inboundText: (item.text ?? "").slice(0, 500) || null,
  });
  scheduleStuckTurnWatch(options?.waitUntil, env, item.wamid);
  let firstVisibleSent = false;
  const failsafeWork = sender
    ? sendFirstResponseFailsafe(env, {
        toE164: sender,
        wamid: item.wamid,
        alreadyVisible: () => firstVisibleSent,
      }).catch(() => ({ sent: false, timedOut: true }))
    : Promise.resolve({ sent: false, timedOut: false });
  options?.waitUntil?.(failsafeWork);
  const readResult = await sendWhatsAppReadStatus(env, { messageId: item.wamid }).catch(() => ({
    ok: false,
    supported: false,
    error: "read_failed",
  }));
  marks.readSentAt = Date.now();
  await stampWhatsAppLifecycle(env, item.wamid, {
    readStatusSentAt: nowIso(),
    readStatusOk: readResult.ok ? 1 : 0,
    outboundError: readResult.ok ? null : readResult.error ?? "read_failed",
  });

  const inboundResolved = await resolveInboundUserInput(env, {
    item,
    sender,
    lastUserText: conversation?.turns?.slice().reverse().find((turn) => turn.role === "user")?.text ?? null,
  });
  if (inboundResolved.terminalReply) {
    const sent = await maybeSendReply(env, sender, inboundResolved.terminalReply);
    firstVisibleSent = sent.ok || firstVisibleSent;
    if (inboundResolved.inputKind === "voice") {
      await recordWhatsAppTranscriptionUsage(env, {
        companyId: conversation?.companyId ?? "unknown",
        userId: identity.user.id,
        actorEmail: identity.user.email,
        interactionId: inboundResolved.interactionId ?? item.wamid,
        success: false,
        durationMs: inboundResolved.transcriptionMs ?? 0,
        metadata: {
          channel: "whatsapp",
          inputKind: "voice",
          inputType: "voice",
          transcriptionProvider: inboundResolved.transcriptionProvider ?? null,
          transcriptionFailed: Boolean(inboundResolved.transcriptionFailed),
          transcriptionReason: inboundResolved.transcriptionReason ?? null,
          voiceDownloadFailed: Boolean(inboundResolved.voiceDownloadFailed),
          voiceDownloadReason: inboundResolved.voiceDownloadReason ?? null,
          acknowledgementSent: inboundResolved.acknowledgementSent,
          finalSent: sent.ok,
          costLane: "whatsapp_transcription",
        },
      });
    }
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: conversation?.companyId ?? null,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: inboundResolved.terminalReply,
      toolName: null,
      interactionId: inboundResolved.interactionId ?? null,
      outcome: inboundResolved.outcome ?? "answered",
      inputKind: inboundResolved.inputKind,
      acknowledgementSent: inboundResolved.acknowledgementSent,
    };
  }

  const earlyText = inboundResolved.text.trim();
  if (earlyText && isInstantLocalTurn(earlyText)) {
    // Only coalesce a generic document ask — never wait on a tool-length sibling
    // such as "what document tells me about van policy".
    const sibling = await maybeCoalesceBurst(env, {
      senderE164: sender,
      wamid: item.wamid,
      coalesceMs: Math.min(200, options?.coalesceMs ?? 0),
    });
    if (sibling && isGenericDocumentAsk(sibling.text)) {
      const reply = COMBINED_GREETING_DOCUMENT_REPLY;
      const sent = await maybeSendReply(env, sender, reply);
      firstVisibleSent = sent.ok || firstVisibleSent;
      marks.firstVisibleAt = Date.now();
      marks.finalSentAt = Date.now();
      await rememberTurn(
        env,
        identity.user.id,
        conversation?.companyId ?? identity.memberships[0]?.companyId ?? "unknown",
        conversation?.turns ?? [],
        `${earlyText}\n${sibling.text}`,
        reply,
      );
      const visibleAt = nowIso();
      await stampWhatsAppLifecycle(env, item.wamid, {
        state: "clarification_sent",
        terminal: "clarification_sent",
        replySentAt: visibleAt,
        firstVisibleAt: visibleAt,
        finalSentAt: visibleAt,
        timeToFirstVisibleMs: summariseWhatsAppLatency(marks).timeToFirstVisibleResponseMs,
        finalSendOk: sent.ok ? 1 : 0,
      });
      await stampWhatsAppLifecycle(env, sibling.wamid, {
        state: "clarification_sent",
        terminal: "clarification_sent",
        replySentAt: visibleAt,
        firstVisibleAt: visibleAt,
        finalSentAt: visibleAt,
        finalSendOk: sent.ok ? 1 : 0,
      });
      return {
        handled: true,
        duplicate: false,
        identityFound: true,
        companyId: conversation?.companyId ?? identity.memberships[0]?.companyId ?? null,
        userId: identity.user.id,
        replySent: sent.ok,
        publicReply: reply,
        toolName: null,
        interactionId: null,
        outcome: "clarification_requested",
        intent: "greeting",
        acknowledgementSent: false,
        planAction: "clarify",
        inputKind: inboundResolved.inputKind,
      };
    }
    const reply = instantLocalReply(earlyText);
    const sent = await maybeSendReply(env, sender, reply);
    firstVisibleSent = sent.ok || firstVisibleSent;
    marks.firstVisibleAt = Date.now();
    marks.finalSentAt = Date.now();
    const companyId = conversation?.companyId ?? identity.memberships[0]?.companyId ?? "unknown";
    if (companyId !== "unknown") {
      await rememberTurn(env, identity.user.id, companyId, conversation?.turns ?? [], earlyText, reply);
    }
    await recordAuditEvent(env.DB, {
      companyId: companyId === "unknown" ? null : companyId,
      eventType: "whatsapp.conversation",
      actor: identity.user.email,
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: { channel: "whatsapp", intent: "greeting", cheapPath: true, costLane: "whatsapp_conversation", localGreeting: true },
    }).catch(() => undefined);
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "reply_sent",
      terminal: "reply_sent",
      replySentAt: nowIso(),
      firstVisibleAt: nowIso(),
      finalSentAt: nowIso(),
      timeToFirstVisibleMs: summariseWhatsAppLatency(marks).timeToFirstVisibleResponseMs,
      finalSendOk: sent.ok ? 1 : 0,
    });
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: companyId === "unknown" ? null : companyId,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: reply,
      toolName: null,
      interactionId: null,
      outcome: "answered",
      intent: "greeting",
      acknowledgementSent: false,
      planAction: "chat",
      inputKind: inboundResolved.inputKind,
    };
  }

  const companyDecision = resolveWhatsAppCompany({
    memberships: identity.memberships.map((membership) => ({
      companyId: membership.companyId,
      companyName: membership.companyName,
    })),
    lastCompanyId: conversation?.companyId ?? null,
    pendingSelection: Boolean(conversation?.pendingCompanySelection),
    message: inboundResolved.text,
  });

  if (companyDecision.status === "select") {
    const reply = companySelectionMessage(companyDecision.companies);
    const sent = await maybeSendReply(env, sender, reply, {
      buttons: suggestionButtons({ kind: "company", companies: companyDecision.companies }),
      list:
        companyDecision.companies.length > 3
          ? {
              buttonLabel: "Choose company",
              rows: listRowsFromCompanies(companyDecision.companies),
            }
          : undefined,
    });
    await saveWhatsAppConversation(env, {
      userId: identity.user.id,
      companyId: null,
      pendingCompanySelection: true,
      turns: [],
    });
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "clarification_sent",
      terminal: "clarification_sent",
      replySentAt: new Date().toISOString(),
      firstVisibleAt: new Date().toISOString(),
      finalSentAt: new Date().toISOString(),
      finalSendOk: sent.ok ? 1 : 0,
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
      inputKind: inboundResolved.inputKind,
      buttonsSent: sent.buttonsSent ?? 0,
    };
  }

  marks.identityResolvedAt = Date.now();
  const sameCompany = conversation?.companyId === companyDecision.companyId;
  const priorTurns = sameCompany ? conversation?.turns ?? [] : [];
  const entities = inferEntitiesFromTurns(
    priorTurns,
    sameCompany ? conversation?.entities ?? emptyEntityMemory() : emptyEntityMemory(),
  );
  const text = inboundResolved.text.trim();
  const inputKind = inboundResolved.inputKind;
  const connectors = await listConnectedConnectorIds(env, companyDecision.companyId);
  const qualityRuntime = await resolveActiveWhatsAppRuntime(env, {
    companyId: companyDecision.companyId,
    userId: identity.user.id,
  }).catch(() => DEFAULT_QUALITY_RUNTIME);
  marks.planningStartedAt = Date.now();
  const plan = planWhatsAppTurn({ text, memory: entities, connectors }, qualityRuntime);
  const intent = plan.intent || classifyWhatsAppIntent(text, { hasPriorTurns: priorTurns.length > 0 });
  marks.intentClassifiedAt = Date.now();
  marks.planningCompletedAt = Date.now();
  await stampWhatsAppLifecycle(env, item.wamid, { userStage: "understanding_request" });

  if (!text) {
    const reply = applyCustomerTone(
      "I can answer questions about your connected business systems. Send a short message or a voice note.",
      { maxEmojis: qualityRuntime.responseRules.maxEmojis },
    );
    const sent = await maybeSendReply(env, sender, reply, { qualityRuntime });
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
      intent,
      inputKind,
    };
  }

  if (plan.action === "write_blocked" || intent === "write_action" || looksLikeWriteIntent(text)) {
    const reply = writeIntentWhatsAppMessage();
    const sent = await maybeSendReply(env, sender, reply, { qualityRuntime });
    await rememberTurn(env, identity.user.id, companyDecision.companyId, conversation?.turns ?? [], text, reply, entities);
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "permission_denied",
      terminal: "permission_denied",
      replySentAt: new Date().toISOString(),
      firstVisibleAt: new Date().toISOString(),
      finalSentAt: new Date().toISOString(),
      finalSendOk: sent.ok ? 1 : 0,
    });
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
      intent: "write_action",
    };
  }

  if (plan.action === "clarify") {
    const reply = applyCustomerTone(
      plan.clarification ?? "Can you give me a little more detail so I look in the right place?",
    );
    const sent = await maybeSendReply(env, sender, reply, {
      qualityRuntime,
      buttons: suggestionButtons({
        kind: "clarify_docs",
        documentTitles: recentDocumentTitles(entities),
      }),
    });
    await rememberTurn(env, identity.user.id, companyDecision.companyId, priorTurns, text, reply, entities);
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "clarification_sent",
      terminal: "clarification_sent",
      replySentAt: new Date().toISOString(),
      firstVisibleAt: new Date().toISOString(),
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
      outcome: "clarification_requested",
      intent,
      acknowledgementSent: false,
      planAction: plan.action,
      inputKind,
      buttonsSent: sent.buttonsSent ?? 0,
    };
  }

  if (plan.action === "chat" || plan.action === "capabilities" || isCheapConversationalIntent(intent)) {
    let capabilities: string | null = null;
    if (intent === "help" || intent === "capabilities") {
      if (/\b(price|pricing|quote|rates?)\b/i.test(text)) {
        capabilities = formatPricingCapabilityReply(
          await listConnectedCapabilityLabels(env, companyDecision.companyId),
        );
      } else {
        capabilities = await capabilityReplyForCompany(env, companyDecision.companyId);
      }
    }
    const reply = applyCustomerTone(
      conversationalReply(intent as WhatsAppIntent, { text, capabilities }) ??
        conversationalReply("greeting", { text })!,
    );
    const sent = await maybeSendReply(env, sender, reply, {
      qualityRuntime,
      buttons:
        intent === "help" || intent === "capabilities"
          ? suggestionButtons({ kind: "help", hasXero: connectors.includes("conn_xero") })
          : [],
    });
    await rememberTurn(env, identity.user.id, companyDecision.companyId, priorTurns, text, reply, entities);
    await recordAuditEvent(env.DB, {
      companyId: companyDecision.companyId,
      eventType: "whatsapp.conversation",
      actor: identity.user.email,
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: { channel: "whatsapp", intent, cheapPath: true, costLane: "whatsapp_conversation" },
    });
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "reply_sent",
      terminal: "reply_sent",
      replySentAt: new Date().toISOString(),
      firstVisibleAt: new Date().toISOString(),
      finalSentAt: new Date().toISOString(),
      finalSendOk: sent.ok ? 1 : 0,
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
      outcome: "answered",
      intent,
      acknowledgementSent: false,
      inputKind,
      buttonsSent: sent.buttonsSent ?? 0,
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
  const needsWork = !plan.skipTools;
  const alreadyAcked = await inboundAlreadyAcknowledged(env, item.wamid);
  let acknowledgementSent = Boolean(inboundResolved.acknowledgementSent) || alreadyAcked;
  if (alreadyAcked) firstVisibleSent = true;
  let progressSent = false;
  let fallbackSent = false;
  let typingRefreshes = 0;

  if (needsWork) {
    const typed = await sendWhatsAppTypingIndicator(env, { messageId: item.wamid }).catch(() => ({
      ok: false,
      supported: false,
      error: "typing_failed",
    }));
    marks.typingSentAt = Date.now();
    await stampWhatsAppLifecycle(env, item.wamid, {
      typingSentAt: nowIso(),
      typingOk: typed.ok ? 1 : 0,
    });
  }
  await stampWhatsAppLifecycle(env, item.wamid, {
    state: needsWork ? "planning" : "synthesising",
    planningAt: new Date().toISOString(),
  });

  try {
    marks.planningStartedAt = Date.now();
    marks.toolStartedAt = Date.now();
    const work = options?.simulateMcpTimeout
      ? new Promise<never>(() => undefined)
      : executeWhatsAppPlan(env, {
          companyId: companyDecision.companyId,
          sessionUser,
          plan,
          originalText: text,
          memory: entities,
          interactionId,
          waitUntil: options?.waitUntil,
          marks,
          wamid: item.wamid,
        });
    const watched = await raceWithWhatsAppWatchdog(work, async (kind, body) => {
      const sent = await maybeSendReply(env, sender, body, { qualityRuntime });
      if (!sent.ok) return false;
      if (kind === "ack") {
        acknowledgementSent = true;
        firstVisibleSent = true;
        marks.acknowledgementSentAt = Date.now();
        marks.firstVisibleAt ??= Date.now();
        await stampWhatsAppLifecycle(env, item.wamid, {
          state: "acknowledged",
          acknowledgedAt: new Date().toISOString(),
          acknowledgementSentAt: new Date().toISOString(),
          firstVisibleAt: new Date().toISOString(),
          ackSendOk: 1,
          timeToFirstVisibleMs: summariseWhatsAppLatency(marks).timeToFirstVisibleResponseMs,
        });
        void recordWhatsAppUxUsage(env, {
          companyId: companyDecision.companyId,
          userId: identity.user.id,
          actorEmail: identity.user.email,
          interactionId,
          action: "whatsapp.ack",
          durationMs: summariseWhatsAppLatency(marks).acknowledgementMs ?? 0,
          metadata: { channel: "whatsapp", intent, acknowledgementSent: true, kind: "ack", costLane: "whatsapp_conversation" },
        });
      } else if (kind === "progress") {
        progressSent = true;
        await stampWhatsAppLifecycle(env, item.wamid, {
          progressSentAt: new Date().toISOString(),
          userStage: "searching_documents",
        });
        if (typingRefreshes < TYPING_MAX_REFRESHES) {
          typingRefreshes += 1;
          void sendWhatsAppTypingIndicator(env, { messageId: item.wamid });
        }
        void recordWhatsAppUxUsage(env, {
          companyId: companyDecision.companyId,
          userId: identity.user.id,
          actorEmail: identity.user.email,
          interactionId,
          action: "whatsapp.progress",
          durationMs: PROGRESS_AFTER_MS,
          metadata: { channel: "whatsapp", intent, kind: "progress" },
        });
      } else if (kind === "delay") {
        fallbackSent = true;
        await stampWhatsAppLifecycle(env, item.wamid, {
          delaySentAt: new Date().toISOString(),
        });
        void recordWhatsAppUxUsage(env, {
          companyId: companyDecision.companyId,
          userId: identity.user.id,
          actorEmail: identity.user.email,
          interactionId,
          action: "whatsapp.delay",
          durationMs: DELAY_NOTICE_MS,
          metadata: { channel: "whatsapp", intent, kind: "delay" },
        });
      }
      return true;
    }, { skipAck: !needsWork || alreadyAcked, seed: item.wamid + text });

    if (watched.timedOut) {
      await stampWhatsAppLifecycle(env, item.wamid, {
        state: "failed_notified",
        terminal: "failed_notified",
        replySentAt: new Date().toISOString(),
        firstVisibleAt: new Date().toISOString(),
        lastError: "hard_timeout",
      });
      return {
        handled: true,
        duplicate: false,
        identityFound: true,
        companyId: companyDecision.companyId,
        userId: identity.user.id,
        replySent: true,
        publicReply: timeoutWhatsAppMessage(),
        toolName: null,
        interactionId,
        outcome: "ai_failed",
        intent,
        acknowledgementSent,
        planAction: plan.action,
      };
    }
    if (watched.error || !watched.result) {
      const reply = aiFailureWhatsAppMessage();
      const sent = await maybeSendReply(env, sender, reply, { qualityRuntime });
      await stampWhatsAppLifecycle(env, item.wamid, {
        state: "failed_notified",
        terminal: "failed_notified",
        replySentAt: new Date().toISOString(),
        firstVisibleAt: new Date().toISOString(),
        lastError: "plan_failed",
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
        interactionId,
        outcome: "ai_failed",
        intent,
        acknowledgementSent,
        planAction: plan.action,
      };
    }

    const answered = watched.result;
    acknowledgementSent = acknowledgementSent || watched.acknowledgementSent;
    progressSent = progressSent || watched.progressSent;
    fallbackSent = fallbackSent || watched.delaySent;
    marks.toolCompletedAt = Date.now();
    marks.finalGeneratedAt = Date.now();
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "synthesising",
      synthesisingAt: new Date().toISOString(),
      toolRunningAt: new Date().toISOString(),
    });

    marks.outboundStartedAt = Date.now();
    const polished = applyCustomerTone(answered.reply, {
      restrained: plan.action === "xero" || answered.outcome === "tool_failed",
    });
    const buttons = buttonsForAnswer({
      plan,
      reply: polished,
      entities: answered.entities,
      connectors,
      outcome: answered.outcome,
    });
    const sent = await maybeSendReply(env, sender, polished, {
      qualityRuntime,
      previewUrl: /^https?:\/\//m.test(polished),
      buttons,
    });
    marks.outboundAcceptedAt = Date.now();
    marks.finalSentAt = Date.now();
    marks.firstVisibleAt ??= Date.now();
    await rememberTurn(
      env,
      identity.user.id,
      companyDecision.companyId,
      priorTurns,
      text,
      polished,
      answered.entities,
    );
    const latency = summariseWhatsAppLatency(marks);
    await recordWhatsAppChannelUsage(env, {
      companyId: companyDecision.companyId,
      userId: identity.user.id,
      actorEmail: identity.user.email,
      interactionId,
      success: answered.outcome === "answered" && sent.ok,
      durationMs: latency.totalMs,
      toolName: answered.toolName,
      send: sent,
      metadata: {
        channel: "whatsapp",
        intent,
        acknowledgementSent,
        acknowledgementMs: latency.acknowledgementMs,
        totalMs: latency.totalMs,
        toolMs: latency.toolMs,
        outboundMs: latency.outboundMs,
        progressSent,
        finalSent: sent.ok,
        cheapPath: false,
        planAction: plan.action,
        usedMemory: plan.useMemory,
        askedLink: plan.action === "memory_link",
        linkReturned: Boolean(answered.entities.lastDocument?.url) && plan.action === "memory_link",
        replyLength: polished.length,
        planningMs: latency.planningMs,
        queueMs: latency.queueMs,
        mcpMs: latency.mcpMs,
        knowledgeSearchMs: latency.knowledgeSearchMs,
        fetchMs: latency.fetchMs,
        synthesisMs: latency.synthesisMs,
        slowestStage: latency.slowestStage,
        broadSearchWithoutTerms: isGenericDocumentAsk(text),
        userRepeatsWhileUnresolved: false,
        rawLeak: /```|__EMPTY|jsessionid=/i.test(polished),
        conversationKind: plan.skipTools ? "conversation" : "tool_mcp",
        costLane: plan.skipTools ? "whatsapp_conversation" : "whatsapp_tool_mcp",
        transportCostLane: "whatsapp_transport",
        firstVisibleMs: latency.firstVisibleMs,
        timeToFirstVisibleResponseMs: latency.timeToFirstVisibleResponseMs,
        readMs: latency.readMs,
        typingMs: latency.typingMs,
        inputKind,
        inputType: inputKind,
        buttonAction: inboundResolved.buttonAction ?? null,
        buttonsSent: sent.buttonsSent ?? buttons.length,
        buttonFailed: Boolean(sent.buttonFailed),
        transcript: inboundResolved.transcript ?? null,
        transcriptionProvider: inboundResolved.transcriptionProvider ?? null,
        transcriptionMs: inboundResolved.transcriptionMs ?? null,
        transcriptionFailed: Boolean(inboundResolved.transcriptionFailed),
        voiceDownloadFailed: Boolean(inboundResolved.voiceDownloadFailed),
        emojiCount: (polished.match(/\p{Extended_Pictographic}/gu) ?? []).length,
      },
    });
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: terminalStateForOutcome({
        outcome: sent.ok ? answered.outcome : "send_failed",
        planAction: plan.action,
        reply: polished,
      }),
      terminal: terminalStateForOutcome({
        outcome: sent.ok ? answered.outcome : "send_failed",
        planAction: plan.action,
        reply: polished,
      }),
      replySentAt: new Date().toISOString(),
      firstVisibleAt: new Date().toISOString(),
      finalSentAt: new Date().toISOString(),
      timeToFirstVisibleMs: latency.timeToFirstVisibleResponseMs,
      finalSendOk: sent.ok ? 1 : 0,
      outboundError: sent.ok ? null : sent.ok === false ? sent.error : "send_failed",
      lastError: sent.ok ? null : "send_failed",
      planningMs: latency.planningMs,
      queueMs: latency.queueMs,
      mcpMs: latency.mcpMs,
      knowledgeSearchMs: latency.knowledgeSearchMs,
      fetchMs: latency.fetchMs,
      synthesisMs: latency.synthesisMs,
      outboundMs: latency.outboundMs,
      totalMs: latency.totalMs,
      slowestStage: latency.slowestStage,
    });
    if (inputKind === "voice") {
      await recordWhatsAppTranscriptionUsage(env, {
        companyId: companyDecision.companyId,
        userId: identity.user.id,
        actorEmail: identity.user.email,
        interactionId,
        success: Boolean(inboundResolved.transcript),
        durationMs: inboundResolved.transcriptionMs ?? 0,
        metadata: {
          channel: "whatsapp",
          inputKind: "voice",
          inputType: "voice",
          transcript: inboundResolved.transcript ?? null,
          transcriptionProvider: inboundResolved.transcriptionProvider ?? null,
          transcriptionMs: inboundResolved.transcriptionMs ?? null,
          costLane: "whatsapp_transcription",
        },
      });
    }
    scheduleQualityAudit(env, options?.waitUntil, interactionId);
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
        intent,
        provider: WHATSAPP_AI_PROVIDER,
        model: WHATSAPP_AI_MODEL,
        sendKind: "customer_service_reply",
        cursorInRuntime: false,
        acknowledgementMs: latency.acknowledgementMs,
        totalMs: latency.totalMs,
      },
    });
    return {
      handled: true,
      duplicate: false,
      identityFound: true,
      companyId: companyDecision.companyId,
      userId: identity.user.id,
      replySent: sent.ok,
      publicReply: polished,
      toolName: answered.toolName,
      interactionId,
      outcome: sent.ok ? answered.outcome : "send_failed",
      intent,
      acknowledgementSent,
      planAction: plan.action,
      inputKind,
      buttonsSent: sent.buttonsSent ?? buttons.length,
    };
  } catch {
    const reply = aiFailureWhatsAppMessage();
    const sent = await maybeSendReply(env, sender, reply, { qualityRuntime });
    await stampWhatsAppLifecycle(env, item.wamid, {
      state: "failed_notified",
      terminal: "failed_notified",
      replySentAt: new Date().toISOString(),
      firstVisibleAt: new Date().toISOString(),
      lastError: "handler_exception",
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
      interactionId,
      outcome: "ai_failed",
      intent,
      acknowledgementSent,
    };
  }
  } finally {
    await releaseWhatsAppChatLock(env, { chatKey: sender, wamid: item.wamid });
  }
}

async function executeWhatsAppPlan(
  env: Env,
  input: {
    companyId: string;
    sessionUser: Awaited<ReturnType<typeof toSessionUser>>;
    plan: WhatsAppPlan;
    originalText: string;
    memory: WhatsAppEntityMemory;
    interactionId: string;
    waitUntil?: (promise: Promise<unknown>) => void;
    marks?: ReturnType<typeof createWhatsAppLatencyMarks>;
    wamid?: string;
  },
): Promise<{
  reply: string;
  toolName: string | null;
  outcome: "answered" | "tool_failed" | "ai_failed";
  latencyMs: number;
  entities: WhatsAppEntityMemory;
}> {
  const started = Date.now();
  const plan = input.plan;
  if (plan.action === "memory_link") {
    let memory = input.memory;
    if (!memory.lastDocument?.url && memory.lastDocument?.title) {
      const hit = await lookupKnowledgeSourceUrl(env, input.companyId, memory.lastDocument.title);
      if (hit?.url) {
        memory = mergeEntityMemory(memory, {
          lastDocument: { ...memory.lastDocument, url: hit.url },
          lastSourceUrl: hit.url,
          lastSourceSystem: hit.sourceType,
        });
      }
    }
    return {
      reply: sourceLinkReply(memory.lastDocument),
      toolName: null,
      outcome: "answered",
      latencyMs: Date.now() - started,
      entities: memory,
    };
  }
  if (plan.action === "memory_source") {
    return {
      reply: sourceAttributionReply(input.memory.lastDocument),
      toolName: null,
      outcome: "answered",
      latencyMs: Date.now() - started,
      entities: input.memory,
    };
  }
  if (plan.action === "memory_fact" && plan.skipTools) {
    return {
      reply: memoryFactReply(plan, input.memory),
      toolName: null,
      outcome: "answered",
      latencyMs: Date.now() - started,
      entities: input.memory,
    };
  }
  if (plan.action === "draft" && plan.skipTools) {
    return {
      reply: draftFromMemory(plan.draftKind ?? "reply", input.memory),
      toolName: null,
      outcome: "answered",
      latencyMs: Date.now() - started,
      entities: input.memory,
    };
  }
  if (plan.action === "memory_fact" && input.memory.lastDocument?.id) {
    const fetched = await executeWhatsAppGateway(
      env,
      {
        actor: { type: "user", user: input.sessionUser },
        companyId: input.companyId,
        toolName: COMPANY_KNOWLEDGE_READ_TOOL,
        arguments: { documentRef: input.memory.lastDocument.id, id: input.memory.lastDocument.id },
        sourceClient: "whatsapp",
        interactionId: input.interactionId,
        waitUntil: input.waitUntil,
      },
      FETCH_TIMEOUT_MS,
      "knowledge_fetch",
    );
    if (fetched && fetched.status === 200) {
      const doc = toStandardFetchPayload(fetched.result, input.memory.lastDocument.id);
      const nextDoc = documentEntityFromHit({
        id: doc.id || input.memory.lastDocument.id,
        title: doc.title || input.memory.lastDocument.title,
        url: doc.url || input.memory.lastDocument.url,
        text: doc.text,
      });
      return {
        reply: memoryFactReply(plan, { ...input.memory, lastDocument: nextDoc }, doc.text),
        toolName: COMPANY_KNOWLEDGE_READ_TOOL,
        outcome: "answered",
        latencyMs: Date.now() - started,
        entities: mergeEntityMemory(input.memory, { lastDocument: nextDoc, lastTool: COMPANY_KNOWLEDGE_READ_TOOL }),
      };
    }
  }

  if (plan.action === "xero" && plan.tool && ALLOWED_WHATSAPP_TOOLS.has(plan.tool)) {
    const xero = await executeWhatsAppGateway(
      env,
      {
        actor: { type: "user", user: input.sessionUser },
        companyId: input.companyId,
        toolName: plan.tool,
        arguments: { query: plan.query || input.originalText },
        sourceClient: "whatsapp",
        interactionId: input.interactionId,
        waitUntil: input.waitUntil,
      },
      MCP_TIMEOUT_MS,
      "xero_mcp",
    );
    if (!xero) {
      return {
        reply: timeoutWhatsAppMessage(),
        toolName: plan.tool,
        outcome: "ai_failed",
        latencyMs: Date.now() - started,
        entities: input.memory,
      };
    }
    if (xero.status === 401 || xero.status === 403) {
      return {
        reply: permissionBlockedWhatsAppMessage("xero"),
        toolName: plan.tool,
        outcome: "tool_failed",
        latencyMs: Date.now() - started,
        entities: input.memory,
      };
    }
    if (xero.status === 200) {
      const reply = formatWhatsAppReply(compressToolResult(xero.result, input.originalText));
      return {
        reply,
        toolName: plan.tool,
        outcome: "answered",
        latencyMs: Date.now() - started,
        entities: mergeEntityMemory(input.memory, {
          lastTool: plan.tool,
          lastDateRange: /last month|this month/i.test(input.originalText)
            ? { label: /last month/i.test(input.originalText) ? "last_month" : "this_month" }
            : input.memory.lastDateRange,
        }),
      };
    }
    return {
      reply: toolFailureWhatsAppMessage(),
      toolName: plan.tool,
      outcome: "tool_failed",
      latencyMs: Date.now() - started,
      entities: input.memory,
    };
  }

  const knowledge = await answerWithCompanyMcp(env, {
    companyId: input.companyId,
    sessionUser: input.sessionUser,
    query: plan.needsGuidance ? guidanceSearchQuery(plan.query || input.originalText) : plan.query || input.originalText,
    originalText: input.originalText,
    interactionId: input.interactionId,
    waitUntil: input.waitUntil,
    fetch: plan.fetch,
    guidanceOnly: plan.needsGuidance && plan.action === "guidance",
    marks: input.marks,
    wamid: input.wamid,
  });

  let reply = knowledge.reply;
  if (plan.action === "price") {
    reply = priceAdviceReply({
      title: knowledge.entity?.title,
      text: knowledge.entity?.excerpt,
      found: knowledge.outcome === "answered" && Boolean(knowledge.entity?.title),
    });
  } else if (plan.action === "draft") {
    const memory = mergeEntityMemory(input.memory, { lastDocument: knowledge.entity, lastTool: knowledge.toolName });
    reply = draftFromMemory(plan.draftKind ?? "reply", memory, knowledge.guidanceTitle ? guidanceInfluenceNote(knowledge.guidanceTitle) : null);
  } else {
    reply = withOptionalSource(reply, knowledge.entity?.title ?? null, input.originalText);
  }

  return {
    reply,
    toolName: knowledge.toolName,
    outcome: knowledge.outcome,
    latencyMs: knowledge.latencyMs,
    entities: mergeEntityMemory(input.memory, {
      lastDocument: knowledge.entity,
      lastTool: knowledge.toolName,
      lastSource: knowledge.entity?.sourceLabel ?? knowledge.entity?.title,
    }),
  };
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
    fetch?: boolean;
    guidanceOnly?: boolean;
    marks?: ReturnType<typeof createWhatsAppLatencyMarks>;
    wamid?: string;
  },
): Promise<{
  reply: string;
  toolName: string;
  outcome: "answered" | "tool_failed" | "ai_failed";
  latencyMs: number;
  entity?: ReturnType<typeof documentEntityFromHit> | null;
  guidanceTitle?: string | null;
}> {
  const started = Date.now();
  const searchTool = COMPANY_KNOWLEDGE_SEARCH_TOOL;
  if (!ALLOWED_WHATSAPP_TOOLS.has(searchTool)) {
    return { reply: toolFailureWhatsAppMessage(), toolName: searchTool, outcome: "tool_failed", latencyMs: 0 };
  }

  const circuit = await knowledgeCircuitOpen(env, input.companyId);
  if (circuit.open) {
    return {
      reply: toolFailureWhatsAppMessage(),
      toolName: searchTool,
      outcome: "tool_failed",
      latencyMs: Date.now() - started,
    };
  }

  if (input.marks) input.marks.knowledgeSearchStartedAt = Date.now();
  if (input.marks) input.marks.mcpStartedAt = Date.now();
  await stampWhatsAppLifecycle(env, input.wamid, {
    state: "tool_running",
    toolRunningAt: new Date().toISOString(),
    userStage: "searching_documents",
  });

  const search = await executeWhatsAppGateway(
    env,
    {
      actor: { type: "user", user: input.sessionUser },
      companyId: input.companyId,
      toolName: searchTool,
      arguments: { query: input.query, limit: SEARCH_CANDIDATE_LIMIT },
      sourceClient: "whatsapp",
      interactionId: input.interactionId,
      waitUntil: input.waitUntil,
    },
    KNOWLEDGE_SEARCH_TIMEOUT_MS,
    "knowledge_search",
  );
  if (input.marks) input.marks.knowledgeSearchCompletedAt = Date.now();

  if (!search) {
    await recordKnowledgeTimeout(env, input.companyId, "knowledge_search_timeout");
    if (input.marks) input.marks.mcpCompletedAt = Date.now();
    return {
      reply: timeoutWhatsAppMessage(),
      toolName: searchTool,
      outcome: "ai_failed",
      latencyMs: Date.now() - started,
    };
  }

  if (search.status !== 200) {
    if (search.status === 401 || search.status === 403) {
      return {
        reply: permissionBlockedWhatsAppMessage("knowledge"),
        toolName: searchTool,
        outcome: "tool_failed",
        latencyMs: Date.now() - started,
      };
    }
    if (FINANCIAL_READ.test(input.originalText)) {
      const xeroTool = /\bprofit|p&l\b/i.test(input.originalText)
        ? "xero_profit_and_loss"
        : "xero_sales_summary";
      if (ALLOWED_WHATSAPP_TOOLS.has(xeroTool)) {
        const xero = await executeWhatsAppGateway(
          env,
          {
            actor: { type: "user", user: input.sessionUser },
            companyId: input.companyId,
            toolName: xeroTool,
            arguments: { query: input.originalText },
            sourceClient: "whatsapp",
            interactionId: input.interactionId,
            waitUntil: input.waitUntil,
          },
          MCP_TIMEOUT_MS,
          "xero_fallback",
        );
        if (xero && xero.status === 200) {
          return {
            reply: formatWhatsAppReply(compressToolResult(xero.result, input.originalText)),
            toolName: xeroTool,
            outcome: "answered",
            latencyMs: Date.now() - started,
          };
        }
      }
    }
    if (search.status >= 500) {
      return {
        reply: Date.now() - started >= KNOWLEDGE_SEARCH_TIMEOUT_MS ? timeoutWhatsAppMessage() : aiFailureWhatsAppMessage(),
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

  await recordKnowledgeSuccess(env, input.companyId);
  let hits = pickBestKnowledgeHits(
    toStandardSearchPayload(search.result).results.slice(0, SEARCH_CANDIDATE_LIMIT),
    input.query,
  );
  if (input.guidanceOnly) {
    const guided = hits.filter((hit) => isGuidanceHit(hit));
    if (guided.length) hits = guided;
  }
  hits = hits.slice(0, SEARCH_CANDIDATE_LIMIT);
  if (input.marks) input.marks.synthesisStartedAt = Date.now();
  let body = formatSearchHits(hits, input.originalText);
  const shouldFetch =
    input.fetch !== false &&
    (input.fetch ||
      FETCH_INTENT.test(input.originalText) ||
      FETCH_INTENT.test(input.query) ||
      /summarise|summarize|more detail|full detail/i.test(input.originalText));

  if (shouldFetch && hits[0]?.id && ALLOWED_WHATSAPP_TOOLS.has(COMPANY_KNOWLEDGE_READ_TOOL)) {
    if (input.marks) input.marks.fetchStartedAt = Date.now();
    await stampWhatsAppLifecycle(env, input.wamid, { userStage: "fetching_source" });
    const toFetch = hits.slice(0, FETCH_TOP_LIMIT);
    let fetchedDoc: { id: string; title: string; text: string; url: string; snippet?: string } | null = null;
    for (const hit of toFetch) {
      const fetched = await executeWhatsAppGateway(
        env,
        {
          actor: { type: "user", user: input.sessionUser },
          companyId: input.companyId,
          toolName: COMPANY_KNOWLEDGE_READ_TOOL,
          arguments: { documentRef: hit.id, id: hit.id },
          sourceClient: "whatsapp",
          interactionId: input.interactionId,
          waitUntil: input.waitUntil,
        },
        FETCH_TIMEOUT_MS,
        "knowledge_fetch",
      );
      if (!fetched) {
        await recordKnowledgeTimeout(env, input.companyId, "knowledge_fetch_timeout");
        break;
      }
      if (fetched.status === 200) {
        const doc = toStandardFetchPayload(fetched.result, hit.id);
        fetchedDoc = {
          id: hit.id,
          title: doc.title && doc.title !== "Untitled document" ? doc.title : hit.title,
          text: doc.text || hit.snippet || "",
          url: doc.url || hit.url || "",
          snippet: hit.snippet,
        };
        break;
      }
    }
    if (input.marks) input.marks.fetchCompletedAt = Date.now();
    if (fetchedDoc) {
      await stampWhatsAppLifecycle(env, input.wamid, { userStage: "preparing_answer" });
      const excerpt = /__EMPTY/.test(fetchedDoc.text)
        ? `${fetchedDoc.title}\n\nThis looks like a spreadsheet. I can give you the useful rows if you want.`
        : compressDocumentAnswer({ title: fetchedDoc.title, text: fetchedDoc.text, question: input.originalText });
      let url = fetchedDoc.url;
      if (!url) {
        const backfill = await lookupKnowledgeSourceUrl(env, input.companyId, fetchedDoc.title);
        url = backfill?.url ?? "";
      }
      const entity = documentEntityFromHit({
        id: fetchedDoc.id,
        title: fetchedDoc.title,
        url,
        text: fetchedDoc.text,
        snippet: fetchedDoc.snippet,
        sourceLabel: fetchedDoc.title,
      });
      if (input.marks) input.marks.synthesisCompletedAt = Date.now();
      if (input.marks) input.marks.mcpCompletedAt = Date.now();
      return {
        reply: excerpt,
        toolName: COMPANY_KNOWLEDGE_READ_TOOL,
        outcome: "answered",
        latencyMs: Date.now() - started,
        entity,
        guidanceTitle: isGuidanceHit(hits[0]!) ? fetchedDoc.title : null,
      };
    }
  }

  if (!hits.length && FINANCIAL_READ.test(input.originalText)) {
    const xeroTool = "xero_sales_summary";
    const xero = await executeWhatsAppGateway(
      env,
      {
        actor: { type: "user", user: input.sessionUser },
        companyId: input.companyId,
        toolName: xeroTool,
        arguments: { query: input.originalText },
        sourceClient: "whatsapp",
        interactionId: input.interactionId,
        waitUntil: input.waitUntil,
      },
      MCP_TIMEOUT_MS,
      "xero_fallback",
    );
    if (xero && xero.status === 200) {
      body = formatWhatsAppReply(compressToolResult(xero.result, input.originalText));
      if (input.marks) input.marks.synthesisCompletedAt = Date.now();
      if (input.marks) input.marks.mcpCompletedAt = Date.now();
      return { reply: body, toolName: xeroTool, outcome: "answered", latencyMs: Date.now() - started };
    }
  }

  await stampWhatsAppLifecycle(env, input.wamid, { userStage: "preparing_answer" });
  const synthesised = await withBoundedTimeout(
    Promise.resolve(formatWhatsAppReply(body)),
    SYNTHESIS_TIMEOUT_MS,
    "synthesis",
  );
  if (input.marks) input.marks.synthesisCompletedAt = Date.now();
  if (input.marks) input.marks.mcpCompletedAt = Date.now();
  const top = hits[0];
  let topUrl = top?.url ?? "";
  if (top && !topUrl) {
    const backfill = await lookupKnowledgeSourceUrl(env, input.companyId, top.title);
    topUrl = backfill?.url ?? "";
  }
  return {
    reply: synthesised.ok ? synthesised.value : timeoutWhatsAppMessage(),
    toolName: searchTool,
    outcome: synthesised.ok ? "answered" : "ai_failed",
    latencyMs: Date.now() - started,
    entity: top
      ? documentEntityFromHit({
          id: top.id,
          title: top.title,
          url: topUrl,
          snippet: top.snippet,
          sourceLabel: top.title,
        })
      : null,
    guidanceTitle: top && isGuidanceHit(top) ? top.title : null,
  };
}

function pickBestKnowledgeHits<T extends { title: string; snippet?: string }>(hits: T[], query: string): T[] {
  if (hits.length <= 1) return hits;
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length > 2 && !["the", "and", "for", "what", "about"].includes(token));
  if (!tokens.length) return hits;
  return [...hits].sort((left, right) => scoreHit(right, tokens) - scoreHit(left, tokens));
}

function scoreHit(hit: { title: string; snippet?: string }, tokens: string[]): number {
  const hay = `${hit.title} ${hit.snippet ?? ""}`.toLowerCase();
  return tokens.reduce((score, token) => score + (hay.includes(token) ? (hit.title.toLowerCase().includes(token) ? 3 : 1) : 0), 0);
}

function formatSearchHits(
  hits: Array<{ title: string; snippet?: string }>,
  question: string,
): string {
  if (!hits.length) {
    return noResultWhatsAppMessage();
  }
  return compressSearchAnswer({
    title: hits[0]!.title,
    snippet: hits[0]!.snippet,
    question,
  });
}

async function resolveInboundUserInput(
  env: Env,
  input: { item: WhatsAppInboundItem; sender: string; lastUserText: string | null },
): Promise<{
  text: string;
  inputKind: "text" | "voice" | "button";
  acknowledgementSent?: boolean;
  terminalReply?: string;
  outcome?: WhatsAppOrchestratorResult["outcome"];
  interactionId?: string | null;
  buttonAction?: string | null;
  transcript?: string | null;
  transcriptionProvider?: string | null;
  transcriptionMs?: number | null;
  transcriptionFailed?: boolean;
  transcriptionReason?: string | null;
  voiceDownloadFailed?: boolean;
  voiceDownloadReason?: string | null;
}> {
  const kind =
    input.item.inputKind ??
    (input.item.type === "audio" || input.item.type === "voice"
      ? "voice"
      : input.item.type === "interactive"
        ? "button"
        : "text");
  if (kind === "button" || input.item.type === "interactive") {
    const mapped = mapButtonToUserText(input.item.buttonId ?? "", input.item.buttonTitle);
    if (!mapped.supported || !mapped.text) {
      return { text: "", inputKind: "button", terminalReply: UNSUPPORTED_BUTTON, buttonAction: mapped.action };
    }
    const text = mapped.action === "try_again" ? input.lastUserText || mapped.text : mapped.text;
    return { text, inputKind: "button", buttonAction: mapped.action };
  }

  if (kind === "voice" || input.item.type === "audio" || input.item.type === "voice") {
    const ack = await maybeSendReply(env, input.sender, VOICE_ACK);
    const downloaded = await downloadWhatsAppMedia(env, input.item.mediaId);
    if (!downloaded.ok) {
      return {
        text: "",
        inputKind: "voice",
        acknowledgementSent: ack.ok,
        terminalReply: VOICE_UNCLEAR,
        voiceDownloadFailed: true,
        voiceDownloadReason: downloaded.reason,
        transcriptionFailed: true,
        transcriptionReason: downloaded.reason,
      };
    }
    const started = Date.now();
    const transcribed = await transcribeWhatsAppAudio(env, {
      bytes: downloaded.bytes,
      mimeType: downloaded.mimeType,
      filename: "whatsapp-voice.ogg",
    });
    const transcriptionMs = Date.now() - started;
    if (!transcribed.ok) {
      const reply = transcribed.reason === "not_configured" ? VOICE_NOT_CONFIGURED : VOICE_UNCLEAR;
      return {
        text: "",
        inputKind: "voice",
        acknowledgementSent: ack.ok,
        terminalReply: reply,
        transcriptionProvider: transcribed.provider,
        transcriptionMs,
        transcriptionFailed: true,
        transcriptionReason: transcribed.reason,
      };
    }
    if (transcribed.text.trim().length < 2) {
      return {
        text: "",
        inputKind: "voice",
        acknowledgementSent: ack.ok,
        terminalReply: VOICE_UNCLEAR,
        transcriptionProvider: transcribed.provider,
        transcriptionMs,
        transcriptionFailed: true,
        transcriptionReason: "empty",
      };
    }
    return {
      text: transcribed.text,
      inputKind: "voice",
      acknowledgementSent: ack.ok,
      transcript: transcribed.text,
      transcriptionProvider: transcribed.provider,
      transcriptionMs,
    };
  }

  return { text: (input.item.text ?? "").trim(), inputKind: "text" };
}

function buttonsForAnswer(input: {
  plan: WhatsAppPlan;
  reply: string;
  entities: WhatsAppEntityMemory;
  connectors: string[];
  outcome: string;
}): WhatsAppReplyButton[] {
  const hasXero = input.connectors.includes("conn_xero");
  if (input.outcome === "tool_failed" || input.plan.action === "write_blocked") return [];
  if (/couldn’t find that/i.test(input.reply)) {
    return suggestionButtons({ kind: "no_result" });
  }
  if (input.plan.action === "xero" && hasXero && !/permission/i.test(input.reply)) {
    return suggestionButtons({ kind: "finance", hasXero });
  }
  if (input.plan.action === "memory_link" || /^https?:\/\//m.test(input.reply)) {
    return suggestionButtons({
      kind: "document",
      hasSourceUrl: /^https?:\/\//m.test(input.reply) || Boolean(input.entities.lastDocument?.url),
    });
  }
  if (input.plan.action === "knowledge" || input.plan.action === "memory_fact" || input.plan.action === "guidance") {
    if (input.reply.length > 520) return suggestionButtons({ kind: "long" });
    return suggestionButtons({
      kind: /email|outlook|inbox/i.test(input.plan.query) ? "email" : "document",
      hasSourceUrl: Boolean(input.entities.lastDocument?.url),
    });
  }
  if (input.plan.action === "draft") return suggestionButtons({ kind: "long" });
  return [];
}

async function maybeSendReply(
  env: Env,
  toE164: string | null,
  body: string,
  options?: {
    previewUrl?: boolean;
    buttons?: WhatsAppReplyButton[];
    list?: { buttonLabel: string; rows: ReturnType<typeof listRowsFromCompanies> };
    qualityRuntime?: QualityRuntimeConfig;
  },
): Promise<WhatsAppSendResult & { buttonsSent?: number; buttonFailed?: boolean }> {
  if (!toE164 || !outboundAiEnabled(env)) {
    return {
      ok: false,
      kind: "customer_service_reply",
      error: "Outbound WhatsApp is not enabled",
      retryable: false,
      attempts: 0,
      httpStatus: null,
      rawAccepted: false,
    };
  }
  const formatted = options?.qualityRuntime
    ? formatWhatsAppReply(body, { maxChars: options.qualityRuntime.responseRules.maxChars })
    : body;
  const text = applyCustomerTone(formatted, { maxEmojis: options?.qualityRuntime?.responseRules.maxEmojis });
  if (options?.list?.rows.length) {
    const sent = await sendWhatsAppInteractiveList(env, {
      toE164,
      body: text,
      buttonLabel: options.list.buttonLabel,
      rows: options.list.rows,
      inCustomerServiceWindow: true,
    });
    if (sent.ok) return { ...sent, buttonsSent: options.list.rows.length };
    const fallback = await sendWhatsAppText(env, {
      toE164,
      body: text,
      inCustomerServiceWindow: true,
      previewUrl: options?.previewUrl,
    });
    return { ...fallback, buttonsSent: 0, buttonFailed: true };
  }
  if (options?.buttons && shouldAttachButtons(text, options.buttons)) {
    const sent = await sendWhatsAppInteractiveButtons(env, {
      toE164,
      body: text,
      buttons: options.buttons,
      inCustomerServiceWindow: true,
    });
    if (sent.ok) return { ...sent, buttonsSent: options.buttons.length };
    const fallback = await sendWhatsAppText(env, {
      toE164,
      body: text,
      inCustomerServiceWindow: true,
      previewUrl: options?.previewUrl,
    });
    return { ...fallback, buttonsSent: 0, buttonFailed: true };
  }
  return sendWhatsAppText(env, {
    toE164,
    body: text,
    inCustomerServiceWindow: true,
    previewUrl: options?.previewUrl,
  });
}

async function rememberTurn(
  env: Env,
  userId: string,
  companyId: string,
  prior: WhatsAppTurn[],
  userText: string,
  assistantText: string,
  entities?: WhatsAppEntityMemory,
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
    entities,
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

async function executeWhatsAppGateway(
  env: Env,
  input: Parameters<typeof executeGatewayRequest>[1],
  timeoutMs: number,
  label: string,
): Promise<Awaited<ReturnType<typeof executeGatewayRequest>> | null> {
  const raced = await withBoundedTimeout(executeGatewayRequest(env, input), timeoutMs, label);
  if (!raced.ok || raced.timedOut) return null;
  return raced.value;
}

/** Skip only a finished turn. ACK (`first_visible_at`) is not terminal — the queue must still search. */
async function inboundAlreadyTerminal(env: Env, wamid: string): Promise<boolean> {
  if (!wamid) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT reply_sent_at, terminal_state, final_sent_at FROM whatsapp_inbound_events WHERE wamid = ? LIMIT 1`,
    )
      .bind(wamid)
      .first<{ reply_sent_at?: string | null; terminal_state?: string | null; final_sent_at?: string | null }>();
    return Boolean(
      isWhatsAppTerminalState(row?.terminal_state) || row?.reply_sent_at || row?.final_sent_at,
    );
  } catch {
    return false;
  }
}

async function inboundAlreadyAcknowledged(env: Env, wamid: string): Promise<boolean> {
  if (!wamid) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT first_visible_at, acknowledgement_sent_at, terminal_state FROM whatsapp_inbound_events WHERE wamid = ? LIMIT 1`,
    )
      .bind(wamid)
      .first<{
        first_visible_at?: string | null;
        acknowledgement_sent_at?: string | null;
        terminal_state?: string | null;
      }>();
    if (isWhatsAppTerminalState(row?.terminal_state)) return false;
    return Boolean(row?.first_visible_at || row?.acknowledgement_sent_at);
  } catch {
    return false;
  }
}

async function recordWhatsAppUxUsage(
  env: Env,
  input: {
    companyId: string;
    userId: string;
    actorEmail: string;
    interactionId: string;
    action: string;
    durationMs: number;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await recordUsageEvent(env.DB, {
    companyId: input.companyId,
    userId: input.userId,
    actorEmail: input.actorEmail,
    resourceType: "whatsapp",
    resourceId: input.action,
    toolName: "whatsapp.ux",
    action: input.action,
    success: true,
    durationMs: input.durationMs,
    sourceClient: "whatsapp",
    requestId: `wa_ux_${input.interactionId}_${input.action}`,
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
      pricingLabel: "whatsapp_ux_not_double_counted",
      pricingRuleId: null,
      rateCardId: null,
      rateCardVersion: null,
      isTestConfig: false,
    },
    metadata: input.metadata,
  }).catch(() => undefined);
}

async function recordWhatsAppTranscriptionUsage(
  env: Env,
  input: {
    companyId: string;
    userId: string;
    actorEmail: string;
    interactionId: string;
    success: boolean;
    durationMs: number;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  if (input.companyId === "unknown") return;
  await recordUsageEvent(env.DB, {
    companyId: input.companyId,
    userId: input.userId,
    actorEmail: input.actorEmail,
    resourceType: "whatsapp_transcription",
    resourceId: "inbound_voice",
    toolName: String(input.metadata.transcriptionProvider ?? "stt"),
    action: "whatsapp.transcribe",
    success: input.success,
    durationMs: input.durationMs,
    sourceClient: "whatsapp",
    requestId: `wa_stt_${input.interactionId}`,
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
      pricingLabel: "whatsapp_transcription_cost_unknown",
      pricingRuleId: null,
      rateCardId: null,
      rateCardVersion: null,
      isTestConfig: false,
    },
    metadata: input.metadata,
  }).catch(() => undefined);
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
    metadata?: Record<string, unknown>;
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
      ...(input.metadata ?? {}),
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
