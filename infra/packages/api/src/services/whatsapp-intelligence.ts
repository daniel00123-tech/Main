import type { SessionUser } from "../auth/session";
import type { Env } from "../env";
import { executeGatewayRequest } from "./gateway";
import {
  GATEWAY_TOOL_ALIASES,
  buildConversationState,
  runIntelligenceTurn,
  type IntelligenceCompleter,
  type IntelligenceDocumentRef,
  type IntelligenceRuntime,
  type IntelligenceToolCall,
  type IntelligenceToolResult,
  type IntelligenceTurnResult,
} from "./intelligence/index";
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
  redactUnsolicitedPii,
  rejectWeakSearchHits,
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
import type { WhatsAppPlan } from "./whatsapp-plan";
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
  },
): Promise<WhatsAppIntelligenceAnswer> {
  const started = Date.now();
  const fetchCache = new Map<string, ReturnType<typeof toStandardFetchPayload>>();
  const runtime = createWhatsAppIntelligenceRuntime(env, {
    companyId: input.companyId,
    sessionUser: input.sessionUser,
    interactionId: input.interactionId,
    waitUntil: input.waitUntil,
    memory: input.memory,
    fetchCache,
  });
  const state = buildConversationState({
    userText: input.originalText,
    currentDocument: documentRefFromEntity(input.memory.lastDocument),
    entities: (input.memory.recentDocuments ?? [])
      .map((doc) => documentRefFromEntity(doc))
      .filter((doc): doc is IntelligenceDocumentRef => Boolean(doc)),
    recentTurns: input.priorTurns,
  });
  const result = await runIntelligenceTurn({
    env,
    text: input.originalText,
    state,
    runtime,
    channel: "whatsapp",
    buttonHint: input.buttonAction ?? null,
    completer: input.completer,
  });

  const nextEntities = mergeEntitiesFromIntelligence(input.memory, result, input.originalText, fetchCache);
  const polished = polishIntelligenceReply(result, nextEntities, input.originalText);
  const plan = planFromIntelligence(result, input.originalText, input.buttonAction);
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
        ? "ai_failed"
        : result.kind === "clarify"
          ? "clarification_requested"
          : "answered",
    latencyMs: Date.now() - started,
    entities: mergeEntityMemory(nextEntities, { lastAnswerText: pii.text, lastUserQuestion: input.originalText }),
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
      : buttonAction === "summarise"
        ? "summary"
        : "answer";
  if (result.kind === "fast_path") {
    return {
      action: "chat",
      intent: "greeting",
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
  if (usedDocument && result.currentDocument) {
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
  if (result.confidence === "none" && result.currentDocument) {
    if (!text.includes(NONE_IN_DOCUMENT_REPLY)) {
      text = `${NONE_IN_DOCUMENT_REPLY} ${SEARCH_OTHER_DOCS_HINT}`;
    } else if (result.offerSearchOther && !/search other/i.test(text)) {
      text = `${text} ${SEARCH_OTHER_DOCS_HINT}`;
    }
  }
  const sourceUrl = firstHttpUrl(entities.lastDocument?.url, result.currentDocument?.url);
  if ((result.citeSource || result.kind === "answer") && sourceUrl && !/https?:\/\//i.test(text)) {
    if (result.citeSource) text = `${text}\n${sourceUrl}`;
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
    lastSourceUrl: lastDocument?.url ?? prior.lastSourceUrl,
    lastSourceSystem: lastDocument?.sourceSystem ?? prior.lastSourceSystem,
  });
}

function documentRefFromEntity(doc?: WhatsAppDocumentEntity | null): IntelligenceDocumentRef | null {
  if (!doc?.id || !doc.title) return null;
  return { id: doc.id, title: doc.title, url: doc.url, source: doc.sourceSystem };
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
  },
): IntelligenceRuntime {
  return {
    async executeTool(call: IntelligenceToolCall): Promise<IntelligenceToolResult> {
      const started = Date.now();
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
  const hits = searchDocument(documentId, query || payload.title, chunks);
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
      none: hits.length === 0,
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
    return { query: String(args.query ?? args.q ?? "").trim() };
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

function clipToolData(value: unknown): unknown {
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= 3_500) return value;
  return { preview: raw.slice(0, 3_500), truncated: true };
}
