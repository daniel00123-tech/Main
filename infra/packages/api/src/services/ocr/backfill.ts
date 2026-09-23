/**
 * Targeted OCR backfill for known low-text / requires_ocr documents.
 * Does not create new knowledge documents and does not mass-reprocess the corpus.
 */

import { resolveExtractionOperatorState, type ExtractionOperatorState } from "@infra/shared";
import type { Env } from "../../env";
import { listMcpEnvironments } from "../control-plane";
import { applyOcrFallbackIfRequired, azureOcrReady } from "./knowledge-ocr";
import { getKnowledgeDocumentAdmin } from "./mcp-ocr-bridge";

export const DEFAULT_OCR_BACKFILL_DOCUMENT_IDS = [54, 71] as const;
export const DEFAULT_OCR_BACKFILL_COMPANY_ID = "co_caddington";

export type OcrBackfillCandidate = {
  documentId: number;
  title: string | null;
  status: string | null;
  mimeType: string | null;
  extractionState: ExtractionOperatorState;
  reason: string;
};

export type OcrBackfillDocumentResult = {
  documentId: number;
  title: string | null;
  skipped?: boolean;
  reason?: string;
  createdNewDocument: false;
  ok?: boolean;
  indexed?: boolean;
  documentStatus?: string;
  extractionState?: string;
  error?: string;
};

export function isOcrBackfillCandidate(input: {
  status?: string | null;
  mimeType?: string | null;
  metadata?: Record<string, unknown>;
}): { candidate: boolean; reason: string; extractionState: ExtractionOperatorState } {
  const metadata = input.metadata ?? {};
  const ocrStatus = String(metadata.ocrStatus ?? "");
  const fallbackOutcome = String(metadata.fallbackOutcome ?? "");
  const extractionQuality = String(metadata.extractionQuality ?? "");
  const extractionState = resolveExtractionOperatorState({
    mimeType: input.mimeType,
    requiresOcr: input.status === "requires_ocr" || fallbackOutcome === "ocr_not_available",
    documentStatus: input.status,
    extractionQuality,
    ocrStatus,
    fallbackOutcome,
    azureConfigured: fallbackOutcome !== "ocr_not_available" && ocrStatus !== "",
  });

  if (ocrStatus === "ocr_completed" && input.status === "indexed") {
    return { candidate: false, reason: "already_ocr_indexed", extractionState: "ocr_success" };
  }
  if (input.status === "requires_ocr") {
    return { candidate: true, reason: "requires_ocr", extractionState };
  }
  if (fallbackOutcome === "ocr_not_available") {
    return { candidate: true, reason: "ocr_not_available", extractionState };
  }
  if (extractionQuality === "heading_only" || extractionQuality === "poor" || extractionQuality === "requires_ocr") {
    return { candidate: true, reason: `extraction_${extractionQuality}`, extractionState };
  }
  if (ocrStatus === "ocr_failed" || ocrStatus === "ocr_limit_exceeded") {
    return { candidate: true, reason: ocrStatus, extractionState: "ocr_failed" };
  }
  return { candidate: false, reason: "not_an_ocr_candidate", extractionState };
}

export async function runOcrBackfill(
  env: Env,
  input: {
    companyId?: string;
    documentIds?: number[];
    dryRun?: boolean;
  } = {},
): Promise<{
  companyId: string;
  azureConfigured: boolean;
  dryRun: boolean;
  candidateCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  createdNewDocuments: false;
  documents: OcrBackfillDocumentResult[];
}> {
  const companyId = input.companyId ?? DEFAULT_OCR_BACKFILL_COMPANY_ID;
  const documentIds = input.documentIds?.length
    ? input.documentIds
    : [...DEFAULT_OCR_BACKFILL_DOCUMENT_IDS];
  const dryRun = input.dryRun === true;
  const azureConfigured = azureOcrReady(env);
  const mcps = await listMcpEnvironments(env.DB, companyId);
  const mcp = mcps[0];

  const documents: OcrBackfillDocumentResult[] = [];
  let processedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;

  if (!mcp) {
    return {
      companyId,
      azureConfigured,
      dryRun,
      candidateCount: documentIds.length,
      processedCount: 0,
      successCount: 0,
      failureCount: documentIds.length,
      skippedCount: 0,
      createdNewDocuments: false,
      documents: documentIds.map((documentId) => ({
        documentId,
        title: null,
        createdNewDocument: false,
        ok: false,
        error: "MCP environment not found",
      })),
    };
  }

  for (const documentId of documentIds) {
    const doc = await getKnowledgeDocumentAdmin(env, mcp, documentId);
    if (!doc) {
      skippedCount += 1;
      documents.push({
        documentId,
        title: null,
        skipped: true,
        reason: "document_not_found",
        createdNewDocument: false,
      });
      continue;
    }

    const eligibility = isOcrBackfillCandidate({
      status: doc.status,
      mimeType: doc.mimeType,
      metadata: doc.metadata,
    });
    if (!eligibility.candidate) {
      skippedCount += 1;
      documents.push({
        documentId,
        title: doc.title,
        skipped: true,
        reason: eligibility.reason,
        createdNewDocument: false,
        documentStatus: doc.status ?? undefined,
        extractionState: eligibility.extractionState,
      });
      continue;
    }

    if (dryRun || !azureConfigured) {
      skippedCount += 1;
      documents.push({
        documentId,
        title: doc.title,
        skipped: true,
        reason: dryRun ? "dry_run" : "ocr_not_available",
        createdNewDocument: false,
        documentStatus: doc.status ?? undefined,
        extractionState: azureConfigured ? eligibility.extractionState : "ocr_not_available",
      });
      continue;
    }

    processedCount += 1;
    const result = await applyOcrFallbackIfRequired(env, mcp, {
      companyId,
      documentId,
      requiresOcr: true,
      documentStatus: doc.status,
      extractionQuality: String(doc.metadata.extractionQuality ?? "") || null,
      mimeType: doc.mimeType,
      title: doc.title,
    });

    if (!result.ok) {
      failureCount += 1;
      documents.push({
        documentId,
        title: doc.title,
        createdNewDocument: false,
        ok: false,
        error: result.message,
      });
      continue;
    }

    if (result.indexed) {
      successCount += 1;
    } else {
      failureCount += 1;
    }
    documents.push({
      documentId,
      title: doc.title,
      createdNewDocument: false,
      ok: result.ok,
      indexed: result.indexed,
      documentStatus: result.documentStatus,
      extractionState: result.extractionState,
      reason: result.indexed ? "ocr_indexed" : result.extractionState ?? "ocr_incomplete",
    });
  }

  return {
    companyId,
    azureConfigured,
    dryRun,
    candidateCount: documentIds.length,
    processedCount,
    successCount,
    failureCount,
    skippedCount,
    createdNewDocuments: false,
    documents,
  };
}
