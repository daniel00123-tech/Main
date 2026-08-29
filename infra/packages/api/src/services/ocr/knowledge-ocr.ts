import {
  OCR_API_VERSION,
  OCR_MODEL_ID,
  OCR_PROVIDER_ID,
  resolveExtractionOperatorState,
  shouldInvokeOcr,
  type ExtractionOperatorState,
  type McpEnvironment,
} from "@infra/shared";
import type { Env } from "../../env";
import type { KnowledgeUploadResult } from "../microsoft-knowledge-bridge";
import { patchKnowledgeDocumentMetadata } from "../microsoft-knowledge-bridge";
import { isAzureOcrConfigured } from "./azure-document-intelligence";
import { getKnowledgeDocumentAdmin, getKnowledgeDocumentBytes, indexExtractedKnowledgeText } from "./mcp-ocr-bridge";
import { ocrDocumentWithEnv } from "./service";
import type { OcrProvider } from "./types";

function withExtractionState(
  result: Extract<KnowledgeUploadResult, { ok: true }>,
  extractionState: ExtractionOperatorState,
): Extract<KnowledgeUploadResult, { ok: true }> {
  return { ...result, extractionState };
}

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
    return withExtractionState(
      {
        ok: true,
        documentId: input.documentId,
        externalId: "",
        indexed: false,
        partial: true,
        requiresOcr: true,
        documentStatus: input.documentStatus ?? "requires_ocr",
      },
      "ocr_not_available",
    );
  }

  if (!shouldInvokeOcr(input)) {
    return withExtractionState(
      {
        ok: true,
        documentId: input.documentId,
        externalId: "",
        indexed: true,
        requiresOcr: false,
        documentStatus: input.documentStatus ?? "indexed",
        extractionState: "native_text_success",
      },
      "native_text_success",
    );
  }

  if (!input.provider && !isAzureOcrConfigured(env)) {
    await patchKnowledgeDocumentMetadata(env, mcp, input.documentId, {
      extractionState: "ocr_not_available",
      fallbackOutcome: "ocr_not_available",
      ocrStatus: "requires_ocr",
    }).catch(() => undefined);
    return withExtractionState(
      {
        ok: true,
        documentId: input.documentId,
        externalId: "",
        indexed: false,
        partial: true,
        requiresOcr: true,
        extractionQuality: input.extractionQuality ?? undefined,
        documentStatus: "requires_ocr",
        extractionState: "ocr_not_available",
      },
      "ocr_not_available",
    );
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
    const extractionState = resolveExtractionOperatorState({
      requiresOcr: true,
      documentStatus: "requires_ocr",
      extractionQuality: input.extractionQuality,
      fallbackOutcome: "ocr_not_available",
      mimeType,
    });
    return withExtractionState(
      {
        ok: true,
        documentId: input.documentId,
        externalId: "",
        indexed: false,
        partial: true,
        requiresOcr: true,
        extractionQuality: input.extractionQuality ?? undefined,
        documentStatus: "requires_ocr",
        extractionState,
      },
      extractionState,
    );
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
      return withExtractionState(
        {
          ok: true,
          documentId: input.documentId,
          externalId: "",
          indexed: true,
          requiresOcr: false,
          extractionQuality: "good",
          documentStatus: "indexed",
          extractionState: "ocr_success",
        },
        "ocr_success",
      );
    }
    const { indexKnowledgeDocumentUntilComplete } = await import("../microsoft-knowledge-bridge");
    const continued = await indexKnowledgeDocumentUntilComplete(env, mcp, input.documentId);
    if (!continued.ok) {
      return { ok: false, code: continued.code, message: continued.message };
    }
    return withExtractionState(
      {
        ok: true,
        documentId: input.documentId,
        externalId: "",
        indexed: !continued.requiresOcr && !continued.partial,
        partial: continued.partial,
        requiresOcr: continued.requiresOcr,
        extractionQuality: continued.extractionQuality,
        documentStatus: continued.documentStatus,
        extractionState: continued.requiresOcr ? "low_text_warning" : "ocr_success",
      },
      continued.requiresOcr ? "low_text_warning" : "ocr_success",
    );
  }

  if (ocr.status !== "ocr_completed" || !ocr.text) {
    const failedStatus = ocr.status === "ocr_limit_exceeded" ? "ocr_limit_exceeded" : "ocr_failed";
    await patchKnowledgeDocumentMetadata(env, mcp, input.documentId, {
      extractionState: "ocr_failed",
      ocrStatus: ocr.status,
      ocrFailureCategory: ocr.failureCategory ?? null,
      fallbackOutcome: ocr.status,
    }).catch(() => undefined);
    return withExtractionState(
      {
        ok: true,
        documentId: input.documentId,
        externalId: "",
        indexed: false,
        partial: true,
        requiresOcr: true,
        extractionQuality: input.extractionQuality ?? ocr.status,
        documentStatus: failedStatus,
        extractionState: "ocr_failed",
      },
      "ocr_failed",
    );
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
      extractionState: "ocr_success",
    },
  });

  if (!indexed.ok) {
    return { ok: false, code: "KNOWLEDGE_OCR_INDEX_FAILED", message: indexed.message };
  }

  return withExtractionState(
    {
      ok: true,
      documentId: input.documentId,
      externalId: "",
      indexed: true,
      partial: false,
      requiresOcr: false,
      extractionQuality: "good",
      documentStatus: indexed.documentStatus ?? "indexed",
      extractionState: "ocr_success",
    },
    "ocr_success",
  );
}

export function azureOcrReady(env: Env): boolean {
  return isAzureOcrConfigured(env);
}
