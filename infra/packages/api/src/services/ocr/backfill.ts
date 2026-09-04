/**
 * Bounded, resumable OCR backfill for documents that only have filename/metadata text.
 * Tenant-scoped. Does not mass-OCR the knowledge base.
 */

import type { Env } from "../../env";
import { listMcpEnvironments } from "../control-plane";
import { applyOcrFallbackIfRequired } from "./knowledge-ocr";
import { listOcrCandidates, type OcrCandidate } from "./mcp-ocr-bridge";

const DEFAULT_BATCH = 5;
const HARD_MAX_BATCH = 15;

export type OcrBackfillResult = {
  companyId: string;
  scanned: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  nextAfterId: number;
  stopped: boolean;
  candidates: Array<{
    documentId: number;
    title: string | null;
    source: string | null;
    outcome: string;
  }>;
};

export function selectBackfillCandidates(candidates: OcrCandidate[]): OcrCandidate[] {
  return candidates.filter((row) => {
    if (row.ocrStatus === "ocr_completed" || row.ocrStatus === "ocr_limit_exceeded") return false;
    if (row.status === "requires_ocr") return true;
    if (row.status === "no_searchable_content" || row.status === "requires_manual_review") return true;
    if (row.extractionQuality === "requires_ocr" || row.extractionQuality === "heading_only" || row.extractionQuality === "poor") {
      return true;
    }
    const substantive = Number(row.substantiveCharacterCount ?? 0);
    return Number.isFinite(substantive) && substantive < 40;
  });
}

export async function runOcrBackfill(
  env: Env,
  input: {
    companyId: string;
    limit?: number;
    afterId?: number;
    dryRun?: boolean;
  },
): Promise<OcrBackfillResult> {
  const limit = Math.min(HARD_MAX_BATCH, Math.max(1, input.limit ?? DEFAULT_BATCH));
  const mcps = await listMcpEnvironments(env.DB, input.companyId);
  const mcp = mcps[0];
  if (!mcp) {
    return {
      companyId: input.companyId,
      scanned: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      nextAfterId: input.afterId ?? 0,
      stopped: true,
      candidates: [],
    };
  }

  const listed = await listOcrCandidates(env, mcp, {
    limit,
    afterId: input.afterId ?? 0,
  });
  const selected = selectBackfillCandidates(listed.candidates);
  const result: OcrBackfillResult = {
    companyId: input.companyId,
    scanned: listed.candidates.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: listed.candidates.length - selected.length,
    nextAfterId: listed.nextAfterId,
    stopped: false,
    candidates: [],
  };

  for (const candidate of selected) {
    if (input.dryRun) {
      result.candidates.push({
        documentId: candidate.documentId,
        title: candidate.title,
        source: candidate.source,
        outcome: "dry_run",
      });
      continue;
    }
    result.processed += 1;
    const ocr = await applyOcrFallbackIfRequired(env, mcp, {
      companyId: input.companyId,
      documentId: candidate.documentId,
      requiresOcr: true,
      title: candidate.title,
      mimeType: candidate.mimeType,
    });
    const outcome = ocr.ok && ocr.indexed ? "ocr_success" : ocr.ok ? (ocr.documentStatus ?? "ocr_failed") : "ocr_failed";
    if (ocr.ok && ocr.indexed) result.succeeded += 1;
    else result.failed += 1;
    result.candidates.push({
      documentId: candidate.documentId,
      title: candidate.title,
      source: candidate.source,
      outcome,
    });
  }

  return result;
}

export async function processDueOcrCandidates(
  env: Env,
  options?: { companyId?: string; limit?: number },
): Promise<OcrBackfillResult[]> {
  const companyId = options?.companyId;
  const companies = companyId
    ? [{ company_id: companyId }]
    : (
        await env.DB.prepare(
          `SELECT DISTINCT company_id FROM connector_instances WHERE auth_status = 'connected'`,
        ).all<{ company_id: string }>()
      ).results ?? [];
  const results: OcrBackfillResult[] = [];
  for (const row of companies) {
    results.push(
      await runOcrBackfill(env, {
        companyId: row.company_id,
        limit: options?.limit ?? 2,
      }),
    );
  }
  return results;
}
