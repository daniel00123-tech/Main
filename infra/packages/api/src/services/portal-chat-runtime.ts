import type { SessionUser } from "../auth/session";
import type { Env } from "../env";
import { executeGatewayRequest } from "./gateway";
import {
  GATEWAY_TOOL_ALIASES,
  SYSTEM_META_TOOLS,
  clipBusinessToolData,
  executeSystemMetaTool,
  enrichDocumentQuery,
  executePublicWebSearch,
} from "./intelligence/index";
import type { IntelligenceRuntime, IntelligenceToolCall, IntelligenceToolResult } from "./intelligence/types.js";
import {
  COMPANY_KNOWLEDGE_READ_TOOL,
  COMPANY_KNOWLEDGE_SEARCH_TOOL,
  firstHttpUrl,
  toStandardFetchPayload,
  toStandardSearchPayload,
} from "./mcp-knowledge-standard";
import { recordUsageEvent } from "./usage";
import { identityFromMetadata, lookupKnowledgeSourceUrl, persistDiscoveredSourceUrl } from "./whatsapp-source-urls";
import { chunksFromFetchPayload, queryTerms, rejectWeakSearchHits, searchDocument } from "./whatsapp-grounded-qa";
import { FETCH_TIMEOUT_MS, KNOWLEDGE_SEARCH_TIMEOUT_MS, MCP_TIMEOUT_MS, withBoundedTimeout } from "./whatsapp-timeouts";
import { PORTAL_CHAT_SOURCE_CLIENT, toolStatusLabel, type PortalChatContext, type PortalChatStatusEvent } from "./portal-chat-types";
import { BUSINESS_GATEWAY_TOOL_SET, businessGatewayTimeoutMs } from "./intelligence/business-gateway-tools";
import {
  getCompanyKnowledgeDocument,
  localKnowledgeHitsToResults,
  mergeKnowledgeSearchHits,
  searchCompanyKnowledgeIndex,
} from "./company-knowledge-index";

export type PortalChatGatewayFn = (
  env: Env,
  input: Parameters<typeof executeGatewayRequest>[1],
) => ReturnType<typeof executeGatewayRequest>;

export function createPortalChatRuntime(
  env: Env,
  input: {
    companyId: string;
    sessionUser: SessionUser;
    interactionId: string;
    context: PortalChatContext;
    connectors: string[];
    waitUntil?: (promise: Promise<unknown>) => void;
    onStatus?: (status: PortalChatStatusEvent) => void;
    executeGateway?: PortalChatGatewayFn;
    trafficClass?: string | null;
  },
): IntelligenceRuntime {
  const fetchCache = new Map<string, ReturnType<typeof toStandardFetchPayload>>();
  const gateway = input.executeGateway ?? executeGatewayRequest;

  return {
    async executeTool(call: IntelligenceToolCall): Promise<IntelligenceToolResult> {
      const started = Date.now();
      const status = toolStatusLabel(call.name);
      if (status) input.onStatus?.({ label: status, tool: call.name });

      if (call.name === "web_search") {
        return executePublicWebSearch(call);
      }
      if (SYSTEM_META_TOOLS.has(call.name)) {
        return runSystemMeta(env, input, call, started);
      }
      if (call.name === "search_document") {
        return runSearchDocument(env, input, call, started, fetchCache, gateway);
      }

      const gatewayName = GATEWAY_TOOL_ALIASES[call.name] ?? call.name;
      if (!BUSINESS_GATEWAY_TOOL_SET.has(gatewayName)) {
        return { name: call.name, ok: false, latencyMs: Date.now() - started, data: null, error: "tool_not_permitted" };
      }

      const args = gatewayArguments(gatewayName, call.arguments, input.context);
      const timeoutMs =
        gatewayName === COMPANY_KNOWLEDGE_SEARCH_TOOL || gatewayName === "search"
          ? KNOWLEDGE_SEARCH_TIMEOUT_MS
          : gatewayName === COMPANY_KNOWLEDGE_READ_TOOL || gatewayName === "fetch"
            ? FETCH_TIMEOUT_MS
            : businessGatewayTimeoutMs(gatewayName, MCP_TIMEOUT_MS);

      const fetched = await withBoundedTimeout(
        gateway(env, {
          actor: { type: "user", user: input.sessionUser, channel: "portal" },
          companyId: input.companyId,
          toolName: gatewayName,
          arguments: args,
          sourceClient: PORTAL_CHAT_SOURCE_CLIENT,
          interactionId: input.interactionId,
          parentRequestId: input.interactionId,
          customerRequestId: input.interactionId,
          trafficClass: input.trafficClass ?? undefined,
          waitUntil: input.waitUntil,
        }),
        timeoutMs,
        `portal_chat_${gatewayName}`,
      );

      const knowledgeSearch = gatewayName === COMPANY_KNOWLEDGE_SEARCH_TOOL || gatewayName === "search";
      const knowledgeRead = gatewayName === COMPANY_KNOWLEDGE_READ_TOOL || gatewayName === "fetch";
      if (!fetched.ok || fetched.timedOut || !fetched.value) {
        if (knowledgeSearch || knowledgeRead) {
          const localFallback = knowledgeSearch
            ? await searchCompanyKnowledgeIndex(env, {
                companyId: input.companyId,
                query: String(args.query ?? ""),
                limit: 8,
              }).catch(() => [])
            : [];
          if (knowledgeSearch && localFallback.length) {
            const hits = rejectWeakSearchHits(localKnowledgeHitsToResults(localFallback), String(args.query ?? ""), {
              currentDocumentId: input.context.currentDocument?.id,
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
          if (knowledgeRead) {
            const localDoc = await getCompanyKnowledgeDocument(env, {
              companyId: input.companyId,
              documentId: String(args.id ?? args.documentRef ?? ""),
            }).catch(() => null);
            if (localDoc) {
              return {
                name: call.name,
                ok: true,
                latencyMs: Date.now() - started,
                data: {
                  document_id: localDoc.id,
                  title: localDoc.title,
                  url: localDoc.url,
                  source: "knowledge_intake",
                  chunks: localDoc.chunks,
                },
              };
            }
          }
        }
        return {
          name: call.name,
          ok: false,
          latencyMs: Date.now() - started,
          data: null,
          error: fetched.timedOut ? "timeout" : "tool_failed",
        };
      }
      if (fetched.value.status !== 200 && !knowledgeSearch && !knowledgeRead) {
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

      if (knowledgeSearch) {
        const payload = fetched.value.status === 200 ? toStandardSearchPayload(fetched.value.result) : { results: [] };
        const query = String(args.query ?? "");
        const localHits = localKnowledgeHitsToResults(
          await searchCompanyKnowledgeIndex(env, {
            companyId: input.companyId,
            query,
            limit: 8,
          }).catch(() => []),
        );
        const merged = mergeKnowledgeSearchHits(localHits, payload.results ?? []);
        const hits = rejectWeakSearchHits(merged, query, {
          currentDocumentId: input.context.currentDocument?.id,
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

      if (knowledgeRead) {
        const documentId = String(args.id ?? args.documentRef ?? "");
        const remoteDoc = fetched.value.status === 200 ? toStandardFetchPayload(fetched.value.result, documentId) : null;
        const remoteEmpty = !remoteDoc || (!String(remoteDoc.text ?? "").trim() && !(remoteDoc.chunks ?? []).length);
        if (remoteEmpty) {
          const localDoc = await getCompanyKnowledgeDocument(env, { companyId: input.companyId, documentId }).catch(() => null);
          if (localDoc) {
            return {
              name: call.name,
              ok: true,
              latencyMs: Date.now() - started,
              data: {
                document_id: localDoc.id,
                title: localDoc.title,
                url: localDoc.url,
                source: "knowledge_intake",
                chunks: localDoc.chunks,
              },
            };
          }
        }
        const doc = remoteDoc ?? toStandardFetchPayload({}, documentId);
        fetchCache.set(doc.id || documentId, doc);
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
        data: clipToolData(fetched.value.result, gatewayName),
      };
    },
  };
}

async function runSystemMeta(
  env: Env,
  input: { companyId: string; sessionUser: SessionUser; interactionId: string; connectors: string[] },
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
        canReadUsers: Boolean(
          input.sessionUser.isPlatformAdmin ||
            membership?.role === "company_admin" ||
            membership?.role === "director",
        ),
        canReadAutomations: true,
      },
      companyName: null,
      connectors: input.connectors,
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
        sourceClient: PORTAL_CHAT_SOURCE_CLIENT,
        requestId: `intel_meta_${input.interactionId}_${call.name}`,
        interactionId: input.interactionId,
        parentRequestId: input.interactionId,
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
        metadata: { lane: "system_meta", cheap: true, channel: "portal" },
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

async function runSearchDocument(
  env: Env,
  input: {
    companyId: string;
    sessionUser: SessionUser;
    interactionId: string;
    context: PortalChatContext;
    waitUntil?: (promise: Promise<unknown>) => void;
    trafficClass?: string | null;
  },
  call: IntelligenceToolCall,
  started: number,
  fetchCache: Map<string, ReturnType<typeof toStandardFetchPayload>>,
  gateway: PortalChatGatewayFn,
): Promise<IntelligenceToolResult> {
  const documentId = String(
    call.arguments.document_id ??
      call.arguments.documentId ??
      call.arguments.id ??
      input.context.currentDocument?.id ??
      "",
  ).trim();
  const query = String(call.arguments.query ?? "").trim();
  if (!documentId) {
    return { name: call.name, ok: false, latencyMs: Date.now() - started, data: null, error: "document_id required" };
  }
  let payload = fetchCache.get(documentId);
  if (!payload) {
    const fetched = await withBoundedTimeout(
      gateway(env, {
        actor: { type: "user", user: input.sessionUser, channel: "portal" },
        companyId: input.companyId,
        toolName: COMPANY_KNOWLEDGE_READ_TOOL,
        arguments: { documentRef: documentId, id: documentId },
        sourceClient: PORTAL_CHAT_SOURCE_CLIENT,
        interactionId: input.interactionId,
        parentRequestId: input.interactionId,
        customerRequestId: input.interactionId,
        trafficClass: input.trafficClass ?? undefined,
        waitUntil: input.waitUntil,
      }),
      FETCH_TIMEOUT_MS,
      "portal_chat_search_document_fetch",
    );
    if (!fetched.ok || fetched.timedOut || !fetched.value || fetched.value.status !== 200) {
      const gatewayError =
        fetched.value && "error" in fetched.value && fetched.value.error
          ? String(fetched.value.error)
          : fetched.timedOut
            ? "timeout"
            : "document_unavailable";
      return {
        name: call.name,
        ok: false,
        latencyMs: Date.now() - started,
        data: fetched.value && "status" in fetched.value ? { status: fetched.value.status, error: gatewayError } : null,
        error: gatewayError,
      };
    }
    payload = toStandardFetchPayload(fetched.value.result, documentId);
    fetchCache.set(documentId, payload);
  }
  const chunks = chunksFromFetchPayload(payload, documentId);
  const enriched = enrichDocumentQuery(query || payload.title, {
    scope: "CURRENT_DOCUMENT",
    currentTitle: payload.title,
    previousUserText: null,
    lastAnswerTopic: input.context.lastAnswerTopic ?? "document",
    userCorrection: false,
    documentChanged: Boolean(input.context.currentDocument && input.context.currentDocument.id !== documentId),
  });
  let ranked = searchDocument(documentId, enriched.query, chunks);
  if (!ranked.length && queryTerms(query).length < 2) {
    ranked = searchDocument(documentId, query || payload.title, chunks);
  }
  const identity = identityFromMetadata(payload.metadata ?? null);
  let url = firstHttpUrl(
    payload.url,
    input.context.currentDocument?.id === documentId ? input.context.currentDocument.url : null,
  );
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
      chunks: ranked.slice(0, 4).map((chunk) => ({
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
  context: PortalChatContext,
): Record<string, unknown> {
  if (toolName === COMPANY_KNOWLEDGE_SEARCH_TOOL || toolName === "search") {
    return { query: String(args.query ?? args.q ?? "").trim() };
  }
  if (toolName === COMPANY_KNOWLEDGE_READ_TOOL || toolName === "fetch") {
    const id = String(
      args.document_id ?? args.documentId ?? args.documentRef ?? args.id ?? context.currentDocument?.id ?? "",
    ).trim();
    return { id, documentRef: id };
  }
  if (toolName === "xero_get_invoice") {
    const invoiceNumber = String(args.invoiceNumber ?? args.invoice_number ?? "").trim();
    const invoiceId = String(args.invoice_id ?? args.invoiceId ?? args.id ?? "").trim();
    return {
      ...(invoiceId ? { invoice_id: invoiceId, invoiceId } : {}),
      ...(invoiceNumber ? { invoiceNumber } : {}),
    };
  }
  return { ...args };
}

function clipToolData(value: unknown, toolName = ""): unknown {
  return clipBusinessToolData(value, toolName);
}
