/**
 * Channel-independent document Q&A.
 * Fetches ONE selected document, retrieves chunks from that document only,
 * and synthesises a grounded answer. Does not search the company corpus.
 */

import type { Env } from "../env";
import { enrichDocumentQuery } from "./intelligence/query-enrichment";
import {
  DOCUMENT_FETCH_AMBIGUOUS,
  fetchCompanyKnowledgeDocument,
  usableDocumentTitle,
} from "./document-fetch";
import { COMPANY_KNOWLEDGE_READ_TOOL, type AdvertisedMcpTool } from "./mcp-knowledge-standard";
import {
  NONE_IN_DOCUMENT_REPLY,
  chunksFromFetchPayload,
  queryTerms,
  runGroundedQa,
  type GroundedMode,
} from "./whatsapp-grounded-qa";

export const ASK_DOCUMENT_TOOL = "ask_document";

export const ASK_DOCUMENT_DESCRIPTION =
  "Answer a question from one already-selected company document. Pass the document id from search/fetch plus the user's question. Use priorQuestion for short follow-ups such as \"what exactly?\" or \"when?\". Reads only that document — do not use this for live Xero, mailbox, or company-wide search. Read-only.";

export function askDocumentToolDefinition(): AdvertisedMcpTool {
  return {
    name: ASK_DOCUMENT_TOOL,
    description: ASK_DOCUMENT_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["documentId", "question"],
      properties: {
        documentId: {
          type: "string",
          minLength: 1,
          description: "Stable document id returned by search or fetch.",
        },
        question: {
          type: "string",
          minLength: 1,
          description: "The user's question about that document.",
        },
        priorQuestion: {
          type: "string",
          description:
            "Previous grounded question on the same document. Required for short follow-ups (what exactly, when, who, more).",
        },
        title: {
          type: "string",
          description: "Document title from search. Used only if fetch-by-id returns no content.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Ask a selected document",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export function isAskDocumentTool(name: string): boolean {
  return name === ASK_DOCUMENT_TOOL;
}

export function withAskDocumentTool<T extends { name: string; description: string; inputSchema: Record<string, unknown> }>(
  tools: T[],
): Array<T | AdvertisedMcpTool> {
  const names = new Set(tools.map((tool) => tool.name));
  const hasKnowledge =
    names.has("search") ||
    names.has("fetch") ||
    names.has("search_company_knowledge") ||
    names.has(COMPANY_KNOWLEDGE_READ_TOOL);
  if (!hasKnowledge || names.has(ASK_DOCUMENT_TOOL)) return tools;
  return [...tools, askDocumentToolDefinition()];
}

export function sanitizeAskDocumentArguments(
  args: Record<string, unknown>,
): { documentId: string; question: string; priorQuestion: string | null; title: string | null } | { error: string } {
  const documentId =
    typeof args.documentId === "string"
      ? args.documentId.trim()
      : typeof args.id === "string"
        ? args.id.trim()
        : typeof args.document_id === "string"
          ? args.document_id.trim()
          : "";
  const question =
    typeof args.question === "string"
      ? args.question.trim()
      : typeof args.query === "string"
        ? args.query.trim()
        : "";
  const priorQuestion =
    typeof args.priorQuestion === "string"
      ? args.priorQuestion.trim()
      : typeof args.previousQuestion === "string"
        ? args.previousQuestion.trim()
        : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!documentId) return { error: "ask_document requires a non-empty arguments.documentId" };
  if (!question) return { error: "ask_document requires a non-empty arguments.question" };
  return { documentId, question, priorQuestion: priorQuestion || null, title: title || null };
}

export function inferDocumentQaMode(question: string): GroundedMode {
  if (/\bmore detail|more on this|anything else\b/i.test(question)) return "more_detail";
  if (/\bsummaris/i.test(question)) return "summarise";
  return "answer";
}

export function buildAskDocumentPublicResult(input: {
  documentId: string;
  title: string;
  url?: string;
  answer: string;
  confidence: string;
  noneInDocument: boolean;
}): Record<string, unknown> {
  return {
    documentId: input.documentId,
    title: input.title,
    url: input.url ?? "",
    answer: input.answer,
    confidence: input.confidence,
    noneInDocument: input.noneInDocument,
    scoped: true,
    globalSearchUsed: false,
  };
}

export async function executeAskDocument(
  env: Env,
  input: {
    companyId: string;
    arguments: Record<string, unknown>;
    actor: string;
    actorUserId?: string | null;
  },
): Promise<
  | { ok: true; result: Record<string, unknown>; diagnostics: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string }
> {
  const sanitized = sanitizeAskDocumentArguments(input.arguments);
  if ("error" in sanitized) {
    return { ok: false, status: 400, code: "ASK_DOCUMENT_INVALID", message: sanitized.error };
  }

  const fetched = await fetchCompanyKnowledgeDocument(env, {
    companyId: input.companyId,
    documentId: sanitized.documentId,
    title: sanitized.title,
    actor: input.actor,
    actorUserId: input.actorUserId,
    sourceClient: "infra-ask-document",
  });
  if (!fetched.ok) {
    if (fetched.code === DOCUMENT_FETCH_AMBIGUOUS) {
      return {
        ok: false,
        status: fetched.status,
        code: fetched.code,
        message: fetched.message,
      };
    }
    return {
      ok: false,
      status: fetched.status >= 400 && fetched.status < 600 ? fetched.status : 502,
      code: fetched.code || "UPSTREAM_FAILURE",
      message: fetched.message || "I couldn’t reach that document just now.",
    };
  }

  const payload = {
    ...fetched.payload,
    title: usableDocumentTitle(fetched.payload.title, sanitized.title) || fetched.payload.title,
  };
  const chunks = chunksFromFetchPayload(payload, sanitized.documentId);
  const enrichment = enrichDocumentQuery(sanitized.question, {
    scope: "CURRENT_DOCUMENT",
    currentTitle: payload.title,
    previousUserText: sanitized.priorQuestion,
    lastAnswerTopic: "document",
    userCorrection: false,
    documentChanged: false,
  });

  const qa = await runGroundedQa(env, {
    question: sanitized.question,
    retrievalQuery: enrichment.query,
    documentId: sanitized.documentId,
    title: payload.title,
    fetch: payload,
    mode: inferDocumentQaMode(sanitized.question),
    previousQuestion: sanitized.priorQuestion,
    path: typeof payload.metadata?.path === "string" ? payload.metadata.path : null,
    tenantId: input.companyId,
  });

  const publicResult = buildAskDocumentPublicResult({
    documentId: sanitized.documentId,
    title: payload.title,
    url: payload.url,
    answer: qa.reply,
    confidence: qa.confidence,
    noneInDocument: qa.confidence === "none",
  });

  return {
    ok: true,
    result: publicResult,
    diagnostics: {
      documentId: sanitized.documentId,
      title: payload.title,
      chunkCount: chunks.length,
      fetchBackend: fetched.diagnostics.backend,
      extractionMethod: fetched.diagnostics.extractionMethod,
      retrievalQuery: enrichment.query,
      enriched: enrichment.enriched,
      decayed: enrichment.decayed,
      usedChunkIds: qa.usedChunkIds,
      confidence: qa.confidence,
      distinctiveTerms: queryTerms(sanitized.question),
      noneInDocument: qa.confidence === "none",
      noneCopy: qa.confidence === "none" ? NONE_IN_DOCUMENT_REPLY : null,
    },
  };
}

