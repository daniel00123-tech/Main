import {
  AZURE_READ_USD_PER_PAGE,
  DEFAULT_MAX_OCR_BYTES,
  DEFAULT_MAX_OCR_JOB_ATTEMPTS,
  DEFAULT_MAX_OCR_PAGES_PER_DOCUMENT,
  OCR_API_VERSION,
  OCR_MODEL_ID,
  OCR_PROVIDER_ID,
  isOcrSupportedMimeType,
  type OcrStatus,
} from "@infra/shared";

export function estimateAzureReadCostUsd(pageCount: number | null | undefined): number {
  const pages = Number(pageCount ?? 0);
  if (!Number.isFinite(pages) || pages <= 0) return 0;
  return Math.round(pages * AZURE_READ_USD_PER_PAGE * 10000) / 10000;
}
import { newId, nowIso } from "../../db/mappers";
import { recordAuditEvent } from "../control-plane";
import { recordUsageEvent } from "../usage";
import { assessPdfExtractionQuality, meaningfulTextLength, stripPdfPageMarkers } from "../knowledge-pdf-extraction";
import { AzureOcrError, createAzureOcrProvider, readAzureOcrConfig } from "./azure-document-intelligence";
import type { OcrDocumentInput, OcrDocumentResult, OcrProvider } from "./types";

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function estimatePdfPageCount(bytes: ArrayBuffer): number | null {
  const latin1 = new TextDecoder("latin1").decode(bytes);
  const matches = latin1.match(/\/Type\s*\/Page(?!s)\b/g);
  if (!matches || matches.length === 0) return null;
  return matches.length;
}

export function assessOcrTextQuality(text: string, pageCount?: number): {
  sufficient: boolean;
  substantiveCharacterCount: number;
} {
  const segments =
    pageCount && pageCount > 1
      ? text.split(/\n(?=#\s*Page\s+\d+)/i).map((part, index) => ({
          text: part,
          metadata: { page: index + 1 },
        }))
      : [{ text, metadata: { page: 1 } }];
  const assessment = assessPdfExtractionQuality(segments, text);
  const substantive = meaningfulTextLength(stripPdfPageMarkers(text));
  return {
    sufficient: !assessment.requiresOcr && substantive >= 40,
    substantiveCharacterCount: substantive,
  };
}

type OcrJobRow = {
  id: string;
  company_id: string;
  knowledge_document_id: number;
  content_fingerprint: string;
  ocr_status: string;
  ocr_page_count: number | null;
  ocr_attempt_count: number;
  ocr_failure_category: string | null;
  last_error: string | null;
};

async function loadCompletedJob(
  db: D1Database,
  input: { companyId: string; documentId: number; fingerprint: string },
): Promise<OcrJobRow | null> {
  return db
    .prepare(
      `SELECT id, company_id, knowledge_document_id, content_fingerprint, ocr_status, ocr_page_count,
              ocr_attempt_count, ocr_failure_category, last_error
       FROM knowledge_ocr_jobs
       WHERE company_id = ? AND knowledge_document_id = ? AND content_fingerprint = ?
       LIMIT 1`,
    )
    .bind(input.companyId, input.documentId, input.fingerprint)
    .first<OcrJobRow>();
}

async function upsertJob(
  db: D1Database,
  input: {
    id?: string;
    companyId: string;
    documentId: number;
    fingerprint: string;
    mimeType: string | null;
    title?: string | null;
    status: OcrStatus;
    pageCount?: number | null;
    attemptCount: number;
    failureCategory?: string | null;
    durationMs?: number | null;
    lastError?: string | null;
    completedAt?: string | null;
  },
): Promise<string> {
  const id = input.id ?? newId("ocr");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO knowledge_ocr_jobs (
         id, company_id, knowledge_document_id, content_fingerprint, mime_type, title,
         ocr_provider, ocr_model, ocr_api_version, ocr_status, ocr_page_count,
         ocr_completed_at, ocr_attempt_count, ocr_failure_category, duration_ms, last_error,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, knowledge_document_id, content_fingerprint) DO UPDATE SET
         ocr_status = excluded.ocr_status,
         ocr_page_count = excluded.ocr_page_count,
         ocr_completed_at = excluded.ocr_completed_at,
         ocr_attempt_count = excluded.ocr_attempt_count,
         ocr_failure_category = excluded.ocr_failure_category,
         duration_ms = excluded.duration_ms,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      input.companyId,
      input.documentId,
      input.fingerprint,
      input.mimeType,
      input.title ?? null,
      OCR_PROVIDER_ID,
      OCR_MODEL_ID,
      OCR_API_VERSION,
      input.status,
      input.pageCount ?? null,
      input.completedAt ?? null,
      input.attemptCount,
      input.failureCategory ?? null,
      input.durationMs ?? null,
      input.lastError ?? null,
      now,
      now,
    )
    .run();
  return id;
}

async function auditOcr(
  db: D1Database,
  eventType: string,
  input: {
    companyId: string;
    documentId: number;
    status: string;
    pageCount?: number | null;
    durationMs?: number | null;
    failureCategory?: string | null;
  },
): Promise<void> {
  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType,
    actor: "system:ocr",
    resourceType: "knowledge_document",
    resourceId: String(input.documentId),
    detail: {
      provider: OCR_PROVIDER_ID,
      model: OCR_MODEL_ID,
      apiVersion: OCR_API_VERSION,
      status: input.status,
      pageCount: input.pageCount ?? null,
      durationMs: input.durationMs ?? null,
      failureCategory: input.failureCategory ?? null,
    },
  });
}

export async function ocrDocument(
  db: D1Database,
  input: OcrDocumentInput,
  options?: { provider?: OcrProvider | null; maxPages?: number; maxBytes?: number },
): Promise<OcrDocumentResult> {
  const fingerprint = input.contentFingerprint ?? (await sha256Hex(input.bytes));
  const existing = await loadCompletedJob(db, {
    companyId: input.companyId,
    documentId: input.documentId,
    fingerprint,
  });
  if (existing?.ocr_status === "ocr_completed") {
    return {
      status: "ocr_completed",
      providerCalled: false,
      alreadyCompleted: true,
      attemptCount: existing.ocr_attempt_count,
      pageCount: existing.ocr_page_count,
      contentFingerprint: fingerprint,
      message: "OCR already completed for this document version",
    };
  }

  if (
    existing &&
    existing.ocr_status === "ocr_failed" &&
    existing.ocr_attempt_count >= DEFAULT_MAX_OCR_JOB_ATTEMPTS
  ) {
    return {
      status: "ocr_failed",
      providerCalled: false,
      attemptCount: existing.ocr_attempt_count,
      failureCategory: existing.ocr_failure_category ?? "PROVIDER",
      contentFingerprint: fingerprint,
      pageCount: existing.ocr_page_count,
      message: "OCR retry limit reached for this document version",
    };
  }

  if (!isOcrSupportedMimeType(input.mimeType ?? "application/pdf")) {
    const attemptCount = (existing?.ocr_attempt_count ?? 0) + 1;
    await upsertJob(db, {
      id: existing?.id,
      companyId: input.companyId,
      documentId: input.documentId,
      fingerprint,
      mimeType: input.mimeType,
      title: input.title,
      status: "ocr_failed",
      attemptCount,
      failureCategory: "DATA",
      lastError: `Unsupported OCR mime type: ${input.mimeType ?? "unknown"}`,
    });
    return {
      status: "ocr_failed",
      providerCalled: false,
      attemptCount,
      failureCategory: "DATA",
      contentFingerprint: fingerprint,
      message: "Document type is not supported for OCR V1",
    };
  }

  const maxPages = options?.maxPages ?? DEFAULT_MAX_OCR_PAGES_PER_DOCUMENT;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_OCR_BYTES;
  const estimatedPages = input.knownPageCount ?? estimatePdfPageCount(input.bytes);

  if (input.bytes.byteLength > maxBytes) {
    await upsertJob(db, {
      id: existing?.id,
      companyId: input.companyId,
      documentId: input.documentId,
      fingerprint,
      mimeType: input.mimeType,
      title: input.title,
      status: "ocr_limit_exceeded",
      pageCount: estimatedPages,
      attemptCount: existing?.ocr_attempt_count ?? 0,
      failureCategory: "PAGE_LIMIT",
      lastError: `Document exceeds OCR size limit (${maxBytes} bytes)`,
    });
    await auditOcr(db, "knowledge.ocr_limit_exceeded", {
      companyId: input.companyId,
      documentId: input.documentId,
      status: "ocr_limit_exceeded",
      pageCount: estimatedPages,
    });
    return {
      status: "ocr_limit_exceeded",
      providerCalled: false,
      attemptCount: existing?.ocr_attempt_count ?? 0,
      failureCategory: "PAGE_LIMIT",
      contentFingerprint: fingerprint,
      pageCount: estimatedPages,
      message: `Document is too large for OCR V1 (limit ${maxBytes} bytes).`,
    };
  }

  if (estimatedPages != null && estimatedPages > maxPages) {
    await upsertJob(db, {
      id: existing?.id,
      companyId: input.companyId,
      documentId: input.documentId,
      fingerprint,
      mimeType: input.mimeType,
      title: input.title,
      status: "ocr_limit_exceeded",
      pageCount: estimatedPages,
      attemptCount: existing?.ocr_attempt_count ?? 0,
      failureCategory: "PAGE_LIMIT",
      lastError: `Document has ${estimatedPages} pages; OCR V1 limit is ${maxPages}`,
    });
    await auditOcr(db, "knowledge.ocr_limit_exceeded", {
      companyId: input.companyId,
      documentId: input.documentId,
      status: "ocr_limit_exceeded",
      pageCount: estimatedPages,
    });
    return {
      status: "ocr_limit_exceeded",
      providerCalled: false,
      attemptCount: existing?.ocr_attempt_count ?? 0,
      failureCategory: "PAGE_LIMIT",
      contentFingerprint: fingerprint,
      pageCount: estimatedPages,
      message: `Document has ${estimatedPages} pages. OCR V1 will not process more than ${maxPages} pages.`,
    };
  }

  const provider = options?.provider === undefined ? null : options.provider;
  if (!provider) {
    return {
      status: "ocr_failed",
      providerCalled: false,
      attemptCount: existing?.ocr_attempt_count ?? 0,
      failureCategory: "CONFIGURATION",
      contentFingerprint: fingerprint,
      message: "Azure Document Intelligence is not configured",
    };
  }

  const attemptCount = (existing?.ocr_attempt_count ?? 0) + 1;
  await upsertJob(db, {
    id: existing?.id,
    companyId: input.companyId,
    documentId: input.documentId,
    fingerprint,
    mimeType: input.mimeType,
    title: input.title,
    status: "ocr_processing",
    pageCount: estimatedPages,
    attemptCount,
  });
  await auditOcr(db, "knowledge.ocr_requested", {
    companyId: input.companyId,
    documentId: input.documentId,
    status: "ocr_processing",
    pageCount: estimatedPages,
  });

  try {
    const analyzed = await provider.analyze({
      bytes: input.bytes,
      mimeType: input.mimeType ?? "application/pdf",
      maxPages,
    });
    if (analyzed.pageCount > maxPages) {
      await upsertJob(db, {
        id: existing?.id,
        companyId: input.companyId,
        documentId: input.documentId,
        fingerprint,
        mimeType: input.mimeType,
        title: input.title,
        status: "ocr_limit_exceeded",
        pageCount: analyzed.pageCount,
        attemptCount,
        failureCategory: "PAGE_LIMIT",
        durationMs: analyzed.durationMs,
        lastError: `Azure reported ${analyzed.pageCount} pages; limit is ${maxPages}`,
      });
      await auditOcr(db, "knowledge.ocr_limit_exceeded", {
        companyId: input.companyId,
        documentId: input.documentId,
        status: "ocr_limit_exceeded",
        pageCount: analyzed.pageCount,
        durationMs: analyzed.durationMs,
      });
      return {
        status: "ocr_limit_exceeded",
        providerCalled: true,
        attemptCount,
        failureCategory: "PAGE_LIMIT",
        contentFingerprint: fingerprint,
        pageCount: analyzed.pageCount,
        durationMs: analyzed.durationMs,
        message: `OCR page limit exceeded (${analyzed.pageCount} > ${maxPages}).`,
      };
    }

    const quality = assessOcrTextQuality(analyzed.text, analyzed.pageCount);
    if (!quality.sufficient) {
      await upsertJob(db, {
        id: existing?.id,
        companyId: input.companyId,
        documentId: input.documentId,
        fingerprint,
        mimeType: input.mimeType,
        title: input.title,
        status: "ocr_failed",
        pageCount: analyzed.pageCount,
        attemptCount,
        failureCategory: "INSUFFICIENT_OCR_TEXT",
        durationMs: analyzed.durationMs,
        lastError: "OCR succeeded but extracted text is not substantive",
      });
      await auditOcr(db, "knowledge.ocr_failed", {
        companyId: input.companyId,
        documentId: input.documentId,
        status: "ocr_failed",
        pageCount: analyzed.pageCount,
        durationMs: analyzed.durationMs,
        failureCategory: "INSUFFICIENT_OCR_TEXT",
      });
      await recordUsageEvent(db, {
        companyId: input.companyId,
        resourceType: "knowledge_ocr",
        resourceId: String(input.documentId),
        action: "ocr_insufficient",
        quantity: analyzed.pageCount,
        unit: "pages",
        success: false,
        durationMs: analyzed.durationMs,
        metadata: {
          provider: OCR_PROVIDER_ID,
          model: OCR_MODEL_ID,
          estimatedUsd: estimateAzureReadCostUsd(analyzed.pageCount),
        },
      });
      return {
        status: "ocr_failed",
        providerCalled: true,
        attemptCount,
        failureCategory: "INSUFFICIENT_OCR_TEXT",
        contentFingerprint: fingerprint,
        pageCount: analyzed.pageCount,
        durationMs: analyzed.durationMs,
        message: "OCR returned no useful text",
      };
    }

    await upsertJob(db, {
      id: existing?.id,
      companyId: input.companyId,
      documentId: input.documentId,
      fingerprint,
      mimeType: input.mimeType,
      title: input.title,
      status: "ocr_completed",
      pageCount: analyzed.pageCount,
      attemptCount,
      durationMs: analyzed.durationMs,
      completedAt: nowIso(),
    });
    await auditOcr(db, "knowledge.ocr_completed", {
      companyId: input.companyId,
      documentId: input.documentId,
      status: "ocr_completed",
      pageCount: analyzed.pageCount,
      durationMs: analyzed.durationMs,
    });
    await recordUsageEvent(db, {
      companyId: input.companyId,
      resourceType: "knowledge_ocr",
      resourceId: String(input.documentId),
      action: "ocr_completed",
      quantity: analyzed.pageCount,
      unit: "pages",
      success: true,
      durationMs: analyzed.durationMs,
      metadata: {
        provider: OCR_PROVIDER_ID,
        model: OCR_MODEL_ID,
        apiVersion: OCR_API_VERSION,
        estimatedUsd: estimateAzureReadCostUsd(analyzed.pageCount),
      },
    });

    return {
      status: "ocr_completed",
      providerCalled: true,
      text: analyzed.text,
      pageCount: analyzed.pageCount,
      attemptCount,
      contentFingerprint: fingerprint,
      durationMs: analyzed.durationMs,
    };
  } catch (err) {
    const category = err instanceof AzureOcrError ? err.category : "PROVIDER";
    const message = err instanceof Error ? err.message : "OCR provider failed";
    await upsertJob(db, {
      id: existing?.id,
      companyId: input.companyId,
      documentId: input.documentId,
      fingerprint,
      mimeType: input.mimeType,
      title: input.title,
      status: "ocr_failed",
      pageCount: estimatedPages,
      attemptCount,
      failureCategory: category,
      lastError: message.slice(0, 240),
    });
    await auditOcr(db, "knowledge.ocr_failed", {
      companyId: input.companyId,
      documentId: input.documentId,
      status: "ocr_failed",
      pageCount: estimatedPages,
      failureCategory: category,
    });
    return {
      status: "ocr_failed",
      providerCalled: true,
      attemptCount,
      failureCategory: category,
      contentFingerprint: fingerprint,
      pageCount: estimatedPages,
      message,
    };
  }
}

export async function ocrDocumentWithEnv(
  env: { DB: D1Database } & Record<string, unknown>,
  input: OcrDocumentInput,
  options?: { provider?: OcrProvider | null },
): Promise<OcrDocumentResult> {
  const config = readAzureOcrConfig(env as import("../../env").Env);
  const provider = options?.provider !== undefined ? options.provider : createAzureOcrProvider(env as import("../../env").Env);
  return ocrDocument(env.DB, input, {
    provider,
    maxPages: config?.maxPages,
    maxBytes: config?.maxBytes,
  });
}
