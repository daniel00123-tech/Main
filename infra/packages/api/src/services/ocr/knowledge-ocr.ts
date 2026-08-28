import {
  OCR_API_VERSION,
  OCR_MODEL_ID,
  OCR_PROVIDER_ID,
  shouldInvokeOcr,
  type McpEnvironment,
} from "@infra/shared";
import type { Env } from "../../env";
import type { KnowledgeUploadResult } from "../microsoft-knowledge-bridge";
import { isAzureOcrConfigured } from "./azure-document-intelligence";
import { getKnowledgeDocumentAdmin, getKnowledgeDocumentBytes, indexExtractedKnowledgeText } from "./mcp-ocr-bridge";
import { ocrDocumentWithEnv } from "./service";
import type { OcrProvider } from "./types";

export async function applyOcrFallbackIfRequired(
  env: Env,
  mcp: McpEnvironment,
  input: {
    companyId: string;
    documentId: number;
    requiresOcr?: boolean;
    documentStatus?: string | null;
    extractionQuality?: string | null;
    bytes?: ArrayBuffer | null;
    mimeType?: string | null;
    title?: string | null;
    knownPageCount?: number | null;
    provider?: OcrProvider | null;
  },
): Promise<KnowledgeUploadResult> {
  if (!input.companyId) {
    return {
      ok: true,
      documentId: input.documentId,
      externalId: "",
      indexed: false,
      partial: true,
      requiresOcr: true,
      documentStatus: input.documentStatus ?? "requires_ocr",
    };
  }

  if (!shouldInvokeOcr(input)) {
    return {
      ok: true,
      documentId: input.documentId,
      externalId: "",
      indexed: true,
      requiresOcr: false,
      documentStatus: input.documentStatus ?? "indexed",
    };
  }

  let bytes = input.bytes ?? null;
  let mimeType = input.mimeType ?? null;
  let title = input.title ?? null;
  let knownPageCount = input.knownPageCount ?? null;

  if (!bytes) {
    const [doc, stored] = await Promise.all([
      getKnowledgeDocumentAdmin(env, mcp, input.documentId),
      getKnowledgeDocumentBytes(env, mcp, input.documentId),
    ]);
    if (doc) {
      title = title ?? doc.title;
      mimeType = mimeType ?? doc.mimeType;
      const pageCount = Number(doc.metadata.pageCount);
      if (Number.isFinite(pageCount) && pageCount > 0) knownPageCount = pageCount;
    }
    bytes = stored?.bytes ?? null;
    mimeType = mimeType ?? stored?.mimeType ?? null;
  }

  if (!bytes) {
    return {
      ok: true,
      documentId: input.documentId,
      externalId: "",
      indexed: false,
      partial: true,
      requiresOcr: true,
      extractionQuality: input.extractionQuality ?? undefined,
      documentStatus: "requires_ocr",
    };
  }

  const ocr = await ocrDocumentWithEnv(env, {
    companyId: input.companyId,
    documentId: input.documentId,
    bytes,
    mimeType,
    title,
    knownPageCount,
  }, { provider: input.provider });

  if (ocr.status === "ocr_completed" && ocr.alreadyCompleted) {
    const existing = await getKnowledgeDocumentAdmin(env, mcp, input.documentId);
    if (existing?.status === "indexed" && existing.metadata.ocrStatus === "ocr_completed") {
      return {
        ok: true,
        documentId: input.documentId,
        externalId: "",
        indexed: true,
        requiresOcr: false,
        extractionQuality: "good",
        documentStatus: "indexed",
      };
    }
    const { indexKnowledgeDocumentUntilComplete } = await import("../microsoft-knowledge-bridge");
    const continued = await indexKnowledgeDocumentUntilComplete(env, mcp, input.documentId);
    if (!continued.ok) {
      return { ok: false, code: continued.code, message: continued.message };
    }
    return {
      ok: true,
      documentId: input.documentId,
      externalId: "",
      indexed: !continued.requiresOcr && !continued.partial,
      partial: continued.partial,
      requiresOcr: continued.requiresOcr,
      extractionQuality: continued.extractionQuality,
      documentStatus: continued.documentStatus,
    };
  }

  if (ocr.status !== "ocr_completed" || !ocr.text) {
    return {
      ok: true,
      documentId: input.documentId,
      externalId: "",
      indexed: false,
      partial: true,
      requiresOcr: true,
      extractionQuality: input.extractionQuality ?? ocr.status,
      documentStatus: ocr.status === "ocr_limit_exceeded" ? "ocr_limit_exceeded" : "requires_ocr",
    };
  }

  const indexed = await indexExtractedKnowledgeText(env, mcp, input.documentId, {
    text: ocr.text,
    fingerprint: ocr.contentFingerprint,
    ocrMetadata: {
      ocrProvider: OCR_PROVIDER_ID,
      ocrModel: OCR_MODEL_ID,
      ocrApiVersion: OCR_API_VERSION,
      ocrStatus: "ocr_completed",
      ocrPageCount: ocr.pageCount ?? null,
      ocrCompletedAt: new Date().toISOString(),
      ocrAttemptCount: ocr.attemptCount,
      ocrFailureCategory: null,
      ocrContentFingerprint: ocr.contentFingerprint,
      fallbackOutcome: "azure_document_intelligence",
      extractionMethod: "azure_document_intelligence_prebuilt_read",
    },
  });

  if (!indexed.ok) {
    return { ok: false, code: "KNOWLEDGE_OCR_INDEX_FAILED", message: indexed.message };
  }

  return {
    ok: true,
    documentId: input.documentId,
    externalId: "",
    indexed: true,
    partial: false,
    requiresOcr: false,
    extractionQuality: "good",
    documentStatus: indexed.documentStatus ?? "indexed",
  };
}

export function azureOcrReady(env: Env): boolean {
  return isAzureOcrConfigured(env);
}
