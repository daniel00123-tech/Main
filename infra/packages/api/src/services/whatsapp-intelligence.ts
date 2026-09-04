import type { SessionUser } from "../auth/session";
import type { Env } from "../env";
import { executeGatewayRequest } from "./gateway";
import {
  GATEWAY_TOOL_ALIASES,
  SYSTEM_META_TOOLS,
  buildConversationState,
  executeSystemMetaTool,
  permittedToolsForConnectors,
  runIntelligenceTurn,
  withResolvedBusinessDates,
  enrichDocumentQuery,
  type IntelligenceCompleter,
  type IntelligenceDocumentRef,
  type IntelligenceRuntime,
  type IntelligenceScope,
  type IntelligenceToolCall,
  type IntelligenceToolResult,
  type IntelligenceTurnResult,
} from "./intelligence/index";
import { recordUsageEvent } from "./usage";
import { collectQualityFlags } from "./intelligence/quality.js";
import {
  COMPANY_KNOWLEDGE_READ_TOOL,
  COMPANY_KNOWLEDGE_SEARCH_TOOL,
  firstHttpUrl,
  toStandardFetchPayload,
  toStandardSearchPayload,
} from "./mcp-knowledge-standard";
import {
  classifyDocument,
  chunksFromFetchPayload,
  extractTypedFacts,
  NONE_IN_DOCUMENT_REPLY,
  queryTerms,
  redactUnsolicitedPii,
  rejectWeakSearchHits,
  runGroundedQa,
  SEARCH_OTHER_DOCS_HINT,
  searchDocument,
  type GroundedConfidence,
} from "./whatsapp-grounded-qa";
import {
  documentEntityFromHit,
  mergeEntityMemory,
  type WhatsAppDocumentEntity,
  type WhatsAppEntityMemory,
} from "./whatsapp-entities";
import { identityFromMetadata, lookupKnowledgeSourceUrl, persistDiscoveredSourceUrl } from "./whatsapp-source-urls";
import { FETCH_TIMEOUT_MS, KNOWLEDGE_SEARCH_TIMEOUT_MS, MCP_TIMEOUT_MS, withBoundedTimeout } from "./whatsapp-timeouts";
import { isNegativeResultFeedback, looksLikeSearchOtherDocs, type WhatsAppPlan } from "./whatsapp-plan";
import { softenSearchQuery } from "./whatsapp-intent";
import type { WhatsAppTurn } from "./whatsapp-context";

const ALLOWED_GATEWAY_TOOLS = new Set([
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
  "outlook_search_mailbox",
  "outlook_list_messages",
  "ask_document",
  "list_documents",
]);

export type WhatsAppIntelligenceAnswer = {
  reply: string;
  toolName: string | null;
  outcome: "answered" | "tool_failed" | "ai_failed" | "clarification_requested";
  latencyMs: number;
  entities: WhatsAppEntityMemory;
  groundedConfidence?: GroundedConfidence | null;
  groundedScoped?: boolean;
  synthesisProvider?: string | null;
  moreDetailNovel?: boolean;
  repeatedExcerpt?: boolean;
  unsolicitedPii?: boolean;
  malformedExtraction?: boolean;
  intelligence: IntelligenceTurnResult | null;
  plan: WhatsAppPlan;
};

export async function executeWhatsAppIntelligence(
  env: Env,
  input: {
    companyId: string;
    sessionUser: SessionUser;
    originalText: string;
    memory: WhatsAppEntityMemory;
    priorTurns: WhatsAppTurn[];
    interactionId: string;
    waitUntil?: (promise: Promise<unknown>) => void;
    buttonAction?: string | null;
    completer?: IntelligenceCompleter;
    connectors?: string[];
    qualityGuidance?: string | null;
  },
): Promise<WhatsAppIntelligenceAnswer> {
  const started = Date.now();
  const buttonAction =
    input.buttonAction ?? (looksLikeSearchOtherDocs(input.originalText) ? "search_other_docs" : null);
  const originalText =
    buttonAction === "search_other_docs"
      ? input.memory.lastUserQuestion || input.memory.lastSearchQuery || input.originalText
      : input.originalText;
  const userCorrection = isNegativeResultFeedback(input.originalText) && buttonAction !== "search_other_docs";
  const fetchCache = new Map<string, ReturnType<typeof toStandardFetchPayload>>();
  const runtime = createWhatsAppIntelligenceRuntime(env, {
    companyId: input.companyId,
    sessionUser: input.sessionUser,
    interactionId: input.interactionId,
    waitUntil: input.waitUntil,
    memory: input.memory,
    fetchCache,
    connectors: input.connectors ?? [],
  });
  const connectors = input.connectors ?? [];
  const membership = input.sessionUser.memberships.find((row) => row.companyId === input.companyId);
  const state = buildConversationState({
    userText: originalText,
    currentDocument: documentRefFromEntity(input.memory.lastDocument),
    entities: (input.memory.recentDocuments ?? [])
      .map((doc) => documentRefFromEntity(doc))
      .filter((doc): doc is IntelligenceDocumentRef => Boolean(doc)),
    recentTurns: input.priorTurns,
    companyId: input.companyId,
    role: membership?.role ?? null,
    connectors,
    permittedTools: permittedToolsForConnectors(connectors),
    lastToolName: input.memory.lastTool,
    lastToolSummary: input.memory.lastAnswerText ? input.memory.lastAnswerText.slice(0, 240) : null,
    userCorrection,
    recentDocuments: (input.memory.recentDocuments ?? [])
      .map((doc) => documentRefFromEntity(doc))
      .filter((doc): doc is IntelligenceDocumentRef => Boolean(doc)),
    currentScope: (input.memory.currentScope as IntelligenceScope | undefined) ?? null,
    currentBusinessSystem: input.memory.currentBusinessSystem ?? null,
    lastSuccessfulTool: input.memory.lastSuccessfulTool ?? input.memory.lastTool ?? null,
    lastAnswerTopic: input.memory.lastAnswerTopic ?? null,
    lastUserIntent: input.memory.lastUserIntent ?? null,
    lastAnswerText: input.memory.lastAnswerText ?? null,
  });
  let result = await runIntelligenceTurn({
    env,
    text: originalText,
    state,
    runtime,
    channel: "whatsapp",
    buttonHint: buttonAction,
    completer: input.completer,
  });
  if (
    result.kind === "failed" ||
    (result.confidence === "none" &&
      /\b(sales|revenue|profit|p&l|pnl|overdue|xero|invoice|search other)\b/i.test(originalText))
  ) {
    result = await recoverFailedIntelligenceTurn(
      env,
      runtime,
      { ...input, originalText, buttonAction },
      result,
      fetchCache,
    );
  }

  result = {
    ...result,
    qualityFlags: collectQualityFlags({
      result,
      userCorrection,
      expectedStayOnDocument:
        result.scope === "CURRENT_DOCUMENT" &&
        Boolean(input.memory.lastDocument) &&
        !/\b(find|search|look(?:ing)? (for|up)|another|different|other (doc|document|file)|whole system|all documents)\b/i.test(
          originalText,
        ),
      scope: result.scope,
      connectors,
      scopeSwitch: Boolean(result.scope && result.scope !== "CURRENT_DOCUMENT" && input.memory.lastDocument),
      rephrase: result.lastUserIntent === "rephrase",
      previousAnswer: input.memory.lastAnswerText,
    }),
  };
  if (String(env.INTELLIGENCE_SHADOW_EVAL ?? "").trim() === "1" && input.waitUntil && env.AI) {
    input.waitUntil(runShadowEval(env, originalText, state, runtime, result).catch(() => undefined));
  }
  const nextEntities = mergeEntitiesFromIntelligence(input.memory, result, originalText, fetchCache);
  const polished = polishIntelligenceReply(result, nextEntities, originalText);
  const plan = planFromIntelligence(result, originalText, buttonAction);
  const documentClass = nextEntities.lastDocument
    ? classifyDocument({
        title: nextEntities.lastDocument.title,
        text: nextEntities.lastDocument.excerpt,
        path: nextEntities.lastDocument.path,
      })
    : "general";
  const pii = redactUnsolicitedPii(polished, input.originalText, documentClass);
  const facts = extractTypedFacts(pii.text, documentClass);
  const malformedExtraction = documentClass === "cv_resume" && Boolean(facts.amount || facts.reference);

  return {
    reply: pii.text,
    toolName: result.toolCalls.at(-1)?.name ?? null,
    outcome:
      result.kind === "failed"
        ? result.toolCalls.some((call) => !call.ok && /403|permission/i.test(`${call.error ?? ""} ${JSON.stringify(call.data ?? "")}`))
          ? "tool_failed"
          : "ai_failed"
        : result.kind === "clarify"
          ? "clarification_requested"
          : "answered",
    latencyMs: Date.now() - started,
    entities: mergeEntityMemory(nextEntities, { lastAnswerText: pii.text, lastUserQuestion: originalText }),
    groundedConfidence: result.confidence,
    groundedScoped: result.toolCalls.some((call) => call.name === "search_document" || call.name === "get_knowledge_document"),
    synthesisProvider: result.provider,
    moreDetailNovel: input.buttonAction === "more_on_this" || input.buttonAction === "more_detail",
    repeatedExcerpt: false,
    unsolicitedPii: pii.redacted,
    malformedExtraction,
    intelligence: result,
    plan,
  };
}

export function planFromIntelligence(
  result: IntelligenceTurnResult,
  text: string,
  buttonAction?: string | null,
): WhatsAppPlan {
  const usedXero = result.toolCalls.some((call) => call.name.startsWith("xero_"));
  const usedDocument = result.toolCalls.some(
    (call) =>
      call.name === "search_document" ||
      call.name === "get_knowledge_document" ||
      call.name === "fetch",
  );
  const fact =
    buttonAction === "more_on_this" || buttonAction === "more_detail"
      ? "detail"
      : buttonAction === "summarise" || /\bsummaris/i.test(text)
        ? "summary"
        : "answer";
  if (result.kind === "controlled_action") {
    return {
      action: "write_blocked",
      intent: "write_action",
      tool: null,
      query: text,
      fetch: false,
      skipTools: true,
      useMemory: false,
      needsGuidance: false,
      clarification: null,
      fact: null,
      draftKind: null,
    };
  }
  if (result.kind === "fast_path") {
    const link = /^https?:\/\//i.test(result.text.trim());
    return {
      action: link ? "memory_link" : "chat",
      intent: link ? "source_link" : "greeting",
      tool: null,
      query: text,
      fetch: false,
      skipTools: true,
      useMemory: link,
      needsGuidance: false,
      clarification: null,
      fact: null,
      draftKind: null,
    };
  }
  if (result.kind === "clarify") {
    return {
      action: "clarify",
      intent: "clarification",
      tool: null,
      query: text,
      fetch: false,
      skipTools: true,
      useMemory: Boolean(result.currentDocument),
      needsGuidance: false,
      clarification: result.text,
      fact: null,
      draftKind: null,
    };
  }
  if (buttonAction === "open_source") {
    return {
      action: "memory_link",
      intent: "source_link",
      tool: usedDocument ? "get_knowledge_document" : null,
      query: text,
      fetch: usedDocument,
      skipTools: !usedDocument,
      useMemory: true,
      needsGuidance: false,
      clarification: null,
      fact: null,
      draftKind: null,
    };
  }
  const discovered =
    result.toolCalls.some((call) => call.name === "search_company_knowledge") &&
    result.toolCalls.some((call) => call.name === "get_knowledge_document" || call.name === "fetch");
  const usedSystemMeta = result.toolCalls.some((call) => SYSTEM_META_TOOLS.has(call.name));
  if (usedSystemMeta || result.scope === "SYSTEM_META" || result.scope === "CONNECTOR_CAPABILITY") {
    return {
      action: result.scope === "CONNECTOR_CAPABILITY" ? "capabilities" : "system_meta",
      intent: result.lastUserIntent || (result.scope === "CONNECTOR_CAPABILITY" ? "capabilities" : "system_meta"),
      tool: result.toolCalls[0]?.name ?? null,
      query: text,
      fetch: false,
      skipTools: false,
      useMemory: true,
      needsGuidance: false,
      clarification: null,
      fact: null,
      draftKind: null,
    };
  }
  if (result.scope === "GENERAL_CONVERSATION" && result.toolCalls.length === 0) {
    return {
      action: "chat",
      intent: result.lastUserIntent || "conversation",
      tool: null,
      query: text,
      fetch: false,
      skipTools: true,
      useMemory: true,
      needsGuidance: false,
      clarification: null,
      fact: result.lastUserIntent === "rephrase" ? "explain" : null,
      draftKind: null,
    };
  }
  if (usedXero) {
    return {
      action: "xero",
      intent: "finance_read",
      tool: result.toolCalls.find((call) => call.name.startsWith("xero_"))?.name ?? "xero_sales_summary",
      query: text,
      fetch: false,
      skipTools: false,
      useMemory: false,
      needsGuidance: false,
      clarification: null,
      fact: null,
      draftKind: null,
    };
  }
  if (usedDocument && result.currentDocument && !discovered) {
    return {
      action: "memory_fact",
      intent: "knowledge_search",
      tool: "get_knowledge_document",
      query: text,
      fetch: true,
      skipTools: false,
      useMemory: true,
      needsGuidance: false,
      clarification: null,
      fact,
      draftKind: null,
    };
  }
  return {
    action: "knowledge",
    intent: "knowledge_search",
    tool: "search_company_knowledge",
    query: text,
    fetch: usedDocument,
    skipTools: result.toolCalls.length === 0,
    useMemory: Boolean(result.currentDocument),
    needsGuidance: false,
    clarification: null,
    fact,
    draftKind: null,
  };
}

function polishIntelligenceReply(
  result: IntelligenceTurnResult,
  entities: WhatsAppEntityMemory,
  question: string,
): string {
  let text = result.text.trim();
  if (result.kind === "failed" && !text) {
    text = "I couldn't complete that just now. Try again in a moment.";
  }
  if (result.confidence === "none" && result.currentDocument && result.scope === "CURRENT_DOCUMENT") {
    if (!text.includes(NONE_IN_DOCUMENT_REPLY)) {
      text = `${NONE_IN_DOCUMENT_REPLY} ${SEARCH_OTHER_DOCS_HINT}`;
    } else if (result.offerSearchOther && !/search other/i.test(text)) {
      text = `${text} ${SEARCH_OTHER_DOCS_HINT}`;
    }
  }
  const sourceUrl = firstHttpUrl(entities.lastDocument?.url, result.currentDocument?.url);
  const wantsSource =
    result.citeSource ||
    /\b(where did you get|source (url|link)|send me the (link|url)|what('?s| is) the (url|link))\b/i.test(question);
  if (sourceUrl && wantsSource && !/https?:\/\//i.test(text)) {
    text = `${text}\n${sourceUrl}`;
  }
  void question;
  return text;
}

function mergeEntitiesFromIntelligence(
  prior: WhatsAppEntityMemory,
  result: IntelligenceTurnResult,
  question: string,
  fetchCache: Map<string, ReturnType<typeof toStandardFetchPayload>>,
): WhatsAppEntityMemory {
  let lastDocument = prior.lastDocument ?? null;
  if (result.currentDocument) {
    const fetched = fetchCache.get(result.currentDocument.id);
    const identity = identityFromMetadata(fetched?.metadata ?? null);
    lastDocument = documentEntityFromHit({
      id: result.currentDocument.id,
      title: result.currentDocument.title || lastDocument?.title || "Document",
      url: firstHttpUrl(result.currentDocument.url, fetched?.url, lastDocument?.url),
      text: fetched?.text ?? lastDocument?.excerpt ?? "",
      sourceSystem: identity.sourceSystem ?? lastDocument?.sourceSystem,
      providerItemId: identity.providerItemId ?? lastDocument?.providerItemId,
      sourceKey: identity.sourceKey ?? lastDocument?.sourceKey,
      path: identity.path ?? lastDocument?.path,
    });
  }
  return mergeEntityMemory(prior, {
    lastDocument,
    lastTool: result.toolCalls.at(-1)?.name ?? prior.lastTool,
    lastSearchQuery: question,
    lastUserQuestion: question,
    lastSourceUrl: lastDocument?.url ?? prior.lastSourceUrl,
    lastSourceSystem: lastDocument?.sourceSystem ?? prior.lastSourceSystem,
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
  });
}

async function recoverFailedIntelligenceTurn(
  env: Env,
  runtime: IntelligenceRuntime,
  input: {
    originalText: string;
    memory: WhatsAppEntityMemory;
    buttonAction?: string | null;
    companyId: string;
  },
  failed: IntelligenceTurnResult,
  fetchCache: Map<string, ReturnType<typeof toStandardFetchPayload>>,
): Promise<IntelligenceTurnResult> {
  const toolCalls = [...failed.toolCalls];
  let current = failed.currentDocument ?? documentRefFromEntity(input.memory.lastDocument);
  const evidenceDocumentIds = [...failed.evidenceDocumentIds];
  if (
    failed.scope === "SYSTEM_META" ||
    failed.scope === "CONNECTOR_CAPABILITY" ||
    failed.scope === "GENERAL_CONVERSATION" ||
    failed.scope === "AMBIGUOUS"
  ) {
    return failed;
  }
  const failedTool = [...failed.toolCalls].reverse().find((call) => !call.ok);
  if (failedTool && failed.toolCalls.every((call) => !call.ok)) {
    const err = `${failedTool.error ?? ""} ${JSON.stringify(failedTool.data ?? "")}`;
    const permission = /403|permission/i.test(err);
    return {
      ...failed,
      kind: "failed",
      text: permission
        ? "I don't have permission to read that just now."
        : "I can’t reach that system just now. Try again in a moment.",
      confidence: "none",
      offerSearchOther: false,
    };
  }
  if (/\b(sales|revenue|profit|p&l|pnl|overdue|xero|invoice|turnover)\b/i.test(input.originalText) || failed.scope === "BUSINESS_SYSTEM") {
    const xero = await runtime.executeTool({
      name: "xero_sales_summary",
      arguments: withResolvedBusinessDates("xero_sales_summary", {}, input.originalText),
    });
    toolCalls.push(xero);
    return {
      ...failed,
      kind: xero.ok ? "answer" : "failed",
      text: xero.ok
        ? summariseXeroEvidence(xero.data)
        : "I couldn't read Xero just now. Try again in a moment.",
      confidence: xero.ok ? "partial" : "none",
      offerSearchOther: false,
      toolCalls,
      currentDocument: current,
      evidenceDocumentIds,
      clarification: false,
    };
  }
  const broaden =
    input.buttonAction === "search_other_docs" ||
    !current ||
    /\b(find|search|look(?:ing)? (for|up)|pull up|open|switch to|go to|another|different|other (doc|document|file)|broaden|search other)\b/i.test(
      input.originalText,
    );
  if (broaden) {
    let search = toolCalls.find((call) => call.name === "search_company_knowledge");
    if (!search) {
      search = await runtime.executeTool({
        name: "search_company_knowledge",
        arguments: { query: input.originalText },
      });
      toolCalls.push(search);
    }
    const first = firstSearchHit(search.data);
    if (first && !toolCalls.some((call) => call.name === "get_knowledge_document" || call.name === "fetch")) {
      const fetched = await runtime.executeTool({
        name: "get_knowledge_document",
        arguments: { document_id: first.id },
      });
      toolCalls.push(fetched);
      current = documentFromLoose(fetched.data) ?? first;
    }
  } else if (
    current &&
    failed.scope === "CURRENT_DOCUMENT" &&
    !toolCalls.some((call) => call.name === "search_document")
  ) {
    const scoped = await runtime.executeTool({
      name: "search_document",
      arguments: { document_id: current.id, query: input.originalText },
    });
    toolCalls.push(scoped);
    current = documentFromLoose(scoped.data) ?? current;
  }
  if (current && !evidenceDocumentIds.includes(current.id)) evidenceDocumentIds.push(current.id);
  const payload = current ? fetchCache.get(current.id) : null;
  if (current && payload && String(payload.text ?? "").trim().length >= 40) {
    const groundedQuestion = softenSearchQuery(input.originalText);
    const groundedEnrichment = enrichDocumentQuery(groundedQuestion, {
      scope: "CURRENT_DOCUMENT",
      currentTitle: current.title || payload.title,
      previousUserText:
        input.memory.lastUserQuestion && input.memory.lastUserQuestion !== groundedQuestion
          ? input.memory.lastUserQuestion
          : null,
      lastAnswerTopic: input.memory.lastAnswerTopic ?? "document",
      userCorrection: false,
      documentChanged: Boolean(input.memory.lastDocument && input.memory.lastDocument.id !== current.id),
    });
    const grounded = await runGroundedQa(env, {
      question: groundedQuestion,
      retrievalQuery: groundedEnrichment.query,
      documentId: current.id,
      title: current.title || payload.title,
      fetch: payload,
      mode:
        input.buttonAction === "more_on_this" || input.buttonAction === "more_detail"
          ? "more_detail"
          : input.buttonAction === "summarise" || /\bsummaris/i.test(input.originalText)
            ? "summarise"
            : "answer",
      previousAnswer: input.memory.lastAnswerText,
      previousQuestion: input.memory.lastUserQuestion,
      path: input.memory.lastDocument?.path,
      tenantId: input.companyId,
      qualityGuidance: input.qualityGuidance,
    });
    return {
      ...failed,
      kind: "answer",
      text: grounded.reply,
      confidence: grounded.confidence,
      offerSearchOther: grounded.confidence === "none",
      toolCalls,
      currentDocument: current,
      evidenceDocumentIds,
      clarification: false,
      citeSource: failed.citeSource,
    };
  }
  const search = toolCalls.find((call) => call.name === "search_company_knowledge");
  const first = firstSearchHit(search?.data);
  if (first) {
    return {
      ...failed,
      kind: "answer",
      text: `I found ${first.title}.${first.url ? `\n${first.url}` : ""}`,
      confidence: "partial",
      offerSearchOther: true,
      toolCalls,
      currentDocument: first,
      evidenceDocumentIds: first.id ? [...evidenceDocumentIds, first.id] : evidenceDocumentIds,
      clarification: false,
      citeSource: Boolean(first.url),
    };
  }
  return {
    ...failed,
    kind: "answer",
    text: "I couldn’t find that. Tell me the name of the file, or I can search again.",
    confidence: "none",
    offerSearchOther: true,
    toolCalls,
    currentDocument: current,
    evidenceDocumentIds,
    clarification: false,
  };
}

function firstSearchHit(data: unknown): IntelligenceDocumentRef | null {
  if (!data || typeof data !== "object") return null;
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results) || !results[0] || typeof results[0] !== "object") return null;
  const row = results[0] as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const title = String(row.title ?? "").trim();
  if (!id || !title) return null;
  const url = typeof row.url === "string" && /^https?:\/\//i.test(row.url) ? row.url : null;
  return { id, title, url };
}

function documentFromLoose(data: unknown): IntelligenceDocumentRef | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const id = String(row.document_id ?? row.documentId ?? row.id ?? "").trim();
  const title = String(row.title ?? "").trim();
  if (!id || !title) return null;
  const url = typeof row.url === "string" && /^https?:\/\//i.test(row.url) ? row.url : null;
  return { id, title, url };
}

function documentRefFromEntity(doc?: WhatsAppDocumentEntity | null): IntelligenceDocumentRef | null {
  if (!doc?.id || !doc.title) return null;
  return { id: doc.id, title: doc.title, url: doc.url, source: doc.sourceSystem };
}

async function runSystemMetaTool(
  env: Env,
  input: {
    companyId: string;
    sessionUser: SessionUser;
    interactionId: string;
    connectors?: string[];
  },
  call: IntelligenceToolCall,
  started: number,
): Promise<IntelligenceToolResult> {
  const membership = input.sessionUser.memberships.find((row) => row.companyId === input.companyId);
  try {
    const data = await executeSystemMetaTool(env, {
      name: call.name,
      companyId: input.companyId,
      actor: {
        role: membership?.role ?? null,
        isPlatformAdmin: Boolean(input.sessionUser.isPlatformAdmin),
        canReadKnowledge: true,
        canReadUsers: Boolean(input.sessionUser.isPlatformAdmin || membership?.role === "company_admin" || membership?.role === "director"),
        canReadAutomations: true,
      },
      companyName: null,
      connectors: input.connectors ?? [],
    });
    await Promise.resolve(
      recordUsageEvent(env.DB, {
        companyId: input.companyId,
        userId: input.sessionUser.userId,
        actorEmail: input.sessionUser.email,
        resourceType: "intelligence_system_meta",
        resourceId: call.name,
        toolName: call.name,
        action: "intelligence.system_meta",
        success: true,
        durationMs: Date.now() - started,
        sourceClient: "whatsapp",
        requestId: `intel_meta_${input.interactionId}_${call.name}`,
        interactionId: input.interactionId,
        charge: {
          billable: false,
          customerChargeCents: null,
          calculatedSellingCents: null,
          minimumChargeApplied: false,
          underlyingCostCents: 0,
          underlyingCostMicros: 0,
          estimatedCostMicros: 0,
          costBasis: "unknown",
          targetMarginBps: null,
          actualMarginBps: null,
          grossProfitCents: null,
          pricingLabel: "intelligence_system_meta_cheap",
          pricingRuleId: null,
          rateCardId: null,
          rateCardVersion: null,
          isTestConfig: false,
        },
        metadata: { lane: "system_meta", cheap: true },
      }),
    ).catch(() => undefined);
    return { name: call.name, ok: true, latencyMs: Date.now() - started, data };
  } catch (error) {
    return {
      name: call.name,
      ok: false,
      latencyMs: Date.now() - started,
      data: null,
      error: error instanceof Error ? error.message : "system_meta_failed",
    };
  }
}

function createWhatsAppIntelligenceRuntime(
  env: Env,
  input: {
    companyId: string;
    sessionUser: SessionUser;
    interactionId: string;
    waitUntil?: (promise: Promise<unknown>) => void;
    memory: WhatsAppEntityMemory;
    fetchCache: Map<string, ReturnType<typeof toStandardFetchPayload>>;
    connectors?: string[];
  },
): IntelligenceRuntime {
  return {
    async executeTool(call: IntelligenceToolCall): Promise<IntelligenceToolResult> {
      const started = Date.now();
      if (SYSTEM_META_TOOLS.has(call.name)) {
        return runSystemMetaTool(env, input, call, started);
      }
      if (call.name === "search_document") {
        return runSearchDocument(env, input, call, started);
      }
      const gatewayName = GATEWAY_TOOL_ALIASES[call.name] ?? call.name;
      if (!ALLOWED_GATEWAY_TOOLS.has(gatewayName)) {
        return {
          name: call.name,
          ok: false,
          latencyMs: Date.now() - started,
          data: null,
          error: "tool_not_permitted",
        };
      }
      const args = gatewayArguments(gatewayName, call.arguments, input.memory);
      const timeoutMs =
        gatewayName === COMPANY_KNOWLEDGE_SEARCH_TOOL || gatewayName === "search"
          ? KNOWLEDGE_SEARCH_TIMEOUT_MS
          : gatewayName === COMPANY_KNOWLEDGE_READ_TOOL || gatewayName === "fetch"
            ? FETCH_TIMEOUT_MS
            : MCP_TIMEOUT_MS;
      const fetched = await withBoundedTimeout(
        executeGatewayRequest(env, {
          actor: { type: "user", user: input.sessionUser },
          companyId: input.companyId,
          toolName: gatewayName,
          arguments: args,
          sourceClient: "whatsapp",
          interactionId: input.interactionId,
          waitUntil: input.waitUntil,
        }),
        timeoutMs,
        `intelligence_${gatewayName}`,
      );
      if (!fetched.ok || fetched.timedOut || !fetched.value) {
        return {
          name: call.name,
          ok: false,
          latencyMs: Date.now() - started,
          data: null,
          error: fetched.timedOut ? "timeout" : "tool_failed",
        };
      }
      if (fetched.value.status !== 200) {
        const gatewayError =
          "error" in fetched.value && fetched.value.error ? String(fetched.value.error) : "permission_or_tool_error";
        return {
          name: call.name,
          ok: false,
          latencyMs: Date.now() - started,
          data: { status: fetched.value.status, error: gatewayError },
          error: gatewayError,
        };
      }
      if (gatewayName === COMPANY_KNOWLEDGE_SEARCH_TOOL || gatewayName === "search") {
        const payload = toStandardSearchPayload(fetched.value.result);
        const query = String(args.query ?? "");
        const hits = rejectWeakSearchHits(payload.results, query, {
          currentDocumentId: input.memory.lastDocument?.id,
        }).slice(0, 5);
        return {
          name: call.name,
          ok: true,
          latencyMs: Date.now() - started,
          data: {
            results: hits.map((hit) => ({
              id: hit.id,
              title: hit.title,
              url: firstHttpUrl(hit.url),
              snippet: String(hit.snippet ?? "").slice(0, 240),
            })),
          },
        };
      }
      if (gatewayName === COMPANY_KNOWLEDGE_READ_TOOL || gatewayName === "fetch") {
        const documentId = String(args.id ?? args.documentRef ?? "");
        const doc = toStandardFetchPayload(fetched.value.result, documentId);
        input.fetchCache.set(doc.id || documentId, doc);
        const identity = identityFromMetadata(doc.metadata ?? null);
        let url = firstHttpUrl(doc.url);
        if (!url) {
          const backfill = await lookupKnowledgeSourceUrl(env, input.companyId, {
            title: doc.title,
            entityId: doc.id || documentId,
            externalItemId: identity.providerItemId,
            sourceKey: identity.sourceKey,
            path: identity.path,
          });
          url = backfill?.url ?? "";
        }
        if (url) {
          await persistDiscoveredSourceUrl(env, input.companyId, {
            url,
            title: doc.title,
            entityId: doc.id || documentId,
            externalItemId: identity.providerItemId,
          });
        }
        const chunks = chunksFromFetchPayload(doc, doc.id || documentId).slice(0, 6);
        return {
          name: call.name,
          ok: true,
          latencyMs: Date.now() - started,
          data: {
            document_id: doc.id || documentId,
            title: doc.title,
            url,
            source: identity.sourceSystem ?? null,
            chunks: chunks.map((chunk) => ({
              id: chunk.id,
              heading: chunk.heading,
              text: chunk.text.slice(0, 700),
            })),
          },
        };
      }
      return {
        name: call.name,
        ok: true,
        latencyMs: Date.now() - started,
        data: clipToolData(fetched.value.result),
      };
    },
  };
}

async function runSearchDocument(
  env: Env,
  input: {
    companyId: string;
    sessionUser: SessionUser;
    interactionId: string;
    waitUntil?: (promise: Promise<unknown>) => void;
    memory: WhatsAppEntityMemory;
    fetchCache: Map<string, ReturnType<typeof toStandardFetchPayload>>;
  },
  call: IntelligenceToolCall,
  started: number,
): Promise<IntelligenceToolResult> {
  const documentId = String(
    call.arguments.document_id ?? call.arguments.documentId ?? call.arguments.id ?? input.memory.lastDocument?.id ?? "",
  ).trim();
  const query = String(call.arguments.query ?? "").trim();
  if (!documentId) {
    return { name: call.name, ok: false, latencyMs: Date.now() - started, data: null, error: "document_id required" };
  }
  let payload = input.fetchCache.get(documentId);
  if (!payload) {
    const fetched = await withBoundedTimeout(
      executeGatewayRequest(env, {
        actor: { type: "user", user: input.sessionUser },
        companyId: input.companyId,
        toolName: COMPANY_KNOWLEDGE_READ_TOOL,
        arguments: { documentRef: documentId, id: documentId },
        sourceClient: "whatsapp",
        interactionId: input.interactionId,
        waitUntil: input.waitUntil,
      }),
      FETCH_TIMEOUT_MS,
      "intelligence_search_document_fetch",
    );
    if (!fetched.ok || fetched.timedOut || !fetched.value || fetched.value.status !== 200) {
      return {
        name: call.name,
        ok: false,
        latencyMs: Date.now() - started,
        data: null,
        error: fetched.timedOut ? "timeout" : "document_unavailable",
      };
    }
    payload = toStandardFetchPayload(fetched.value.result, documentId);
    input.fetchCache.set(documentId, payload);
  }
  const chunks = chunksFromFetchPayload(payload, documentId);
  const enriched = enrichDocumentQuery(query || payload.title, {
    scope: "CURRENT_DOCUMENT",
    currentTitle: payload.title,
    previousUserText: input.memory.lastUserQuestion && input.memory.lastUserQuestion !== query
      ? input.memory.lastUserQuestion
      : null,
    lastAnswerTopic: input.memory.lastAnswerTopic ?? "document",
    userCorrection: false,
    documentChanged: Boolean(input.memory.lastDocument && input.memory.lastDocument.id !== documentId),
  });
  let ranked = searchDocument(documentId, enriched.query, chunks);
  if (!ranked.length && queryTerms(query).length < 2 && input.memory.lastUserQuestion && input.memory.lastUserQuestion !== query) {
    ranked = searchDocument(documentId, input.memory.lastUserQuestion, chunks);
  }
  if (!ranked.length && chunks.length && queryTerms(query).length < 2 && !enriched.decayed) {
    ranked = chunks.slice(0, 4).map((chunk, index) => ({
      ...chunk,
      score: Math.max(1, chunks.length - index),
    }));
  }
  const hits = ranked.length ? ranked : [];
  const identity = identityFromMetadata(payload.metadata ?? null);
  let url = firstHttpUrl(payload.url, input.memory.lastDocument?.id === documentId ? input.memory.lastDocument.url : null);
  if (!url) {
    const backfill = await lookupKnowledgeSourceUrl(env, input.companyId, {
      title: payload.title,
      entityId: documentId,
      externalItemId: identity.providerItemId,
      sourceKey: identity.sourceKey,
      path: identity.path,
    });
    url = backfill?.url ?? "";
  }
  return {
    name: call.name,
    ok: true,
    latencyMs: Date.now() - started,
    data: {
      document_id: documentId,
      title: payload.title,
      url,
      none: ranked.length === 0 && chunks.length === 0,
      chunks: hits.slice(0, 4).map((chunk) => ({
        id: chunk.id,
        heading: chunk.heading,
        score: chunk.score,
        text: chunk.text.slice(0, 800),
      })),
    },
  };
}

function gatewayArguments(
  toolName: string,
  args: Record<string, unknown>,
  memory: WhatsAppEntityMemory,
): Record<string, unknown> {
  if (toolName === COMPANY_KNOWLEDGE_SEARCH_TOOL || toolName === "search") {
    return { query: softenSearchQuery(String(args.query ?? args.q ?? "").trim()) };
  }
  if (toolName === COMPANY_KNOWLEDGE_READ_TOOL || toolName === "fetch") {
    const id = String(args.document_id ?? args.documentId ?? args.documentRef ?? args.id ?? memory.lastDocument?.id ?? "").trim();
    return { id, documentRef: id };
  }
  if (toolName === "xero_get_invoice") {
    return { invoice_id: String(args.invoice_id ?? args.id ?? "").trim() };
  }
  return { ...args };
}

function summariseXeroEvidence(data: unknown): string {
  if (!data || typeof data !== "object") return "I have the latest permitted Xero sales figures, but nothing readable came back.";
  const raw = JSON.stringify(data);
  const amounts = raw.match(/£\s?[\d,]+(?:\.\d{2})?|[\d,]+\.\d{2}/g)?.slice(0, 4) ?? [];
  if (amounts.length) {
    return `From Xero, the figures I can see include ${amounts.join(", ")}. Ask if you want overdue invoices or a named invoice.`;
  }
  return "I reached Xero. Ask for overdue invoices, a named invoice, or P&L if you want a specific cut.";
}

function clipToolData(value: unknown): unknown {
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= 3_500) return value;
  return { preview: raw.slice(0, 3_500), truncated: true };
}

async function runShadowEval(
  env: Env,
  text: string,
  state: ReturnType<typeof buildConversationState>,
  _runtime: IntelligenceRuntime,
  live: IntelligenceTurnResult,
): Promise<void> {
  void text;
  void state;
  const models = String(env.INTELLIGENCE_SHADOW_MODELS ?? "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!models.length || !env.AI) return;
  for (const model of models) {
    if (model === live.model) continue;
    try {
      await env.AI.run(model, {
        messages: [
          { role: "system", content: "Shadow eval only. Reply with one JSON decision. Do not address the user." },
          { role: "user", content: `Compare-only. Live action was ${live.kind}. User text already answered.` },
        ],
        max_tokens: 80,
        temperature: 0,
      });
    } catch {
      // Shadow never affects the user path.
    }
  }
}
