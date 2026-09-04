/**
 * Tenant-safe evidence. Company A memory never becomes Company B context.
 */

import type { StructuredEvidence } from "./types.js";

function blankEvidence(companyId?: string | null): StructuredEvidence {
  return {
    companyId: companyId ?? null,
    source: null,
    capturedAt: null,
    recentEmail: null,
    recentXero: null,
    recentDocument: null,
    recentCatalogueItem: null,
    lastSuccessfulCalls: [],
  };
}

export type TenantEvidence = StructuredEvidence & {
  companyId?: string | null;
  source?: string | null;
  capturedAt?: string | null;
};

export function stampEvidenceTenant(
  evidence: StructuredEvidence | TenantEvidence | null | undefined,
  companyId: string | null | undefined,
  source = "intelligence",
): TenantEvidence {
  const base = evidence ?? blankEvidence(companyId);
  return {
    ...base,
    companyId: companyId ?? (base as TenantEvidence).companyId ?? null,
    source: (base as TenantEvidence).source ?? source,
    capturedAt: (base as TenantEvidence).capturedAt ?? new Date().toISOString(),
  };
}

export function evidenceBelongsToCompany(
  evidence: TenantEvidence | StructuredEvidence | null | undefined,
  companyId: string | null | undefined,
): boolean {
  if (!evidence || !companyId) return !evidence || !(evidence as TenantEvidence).companyId;
  const marked = (evidence as TenantEvidence).companyId;
  return !marked || marked === companyId;
}

export function isolateEvidenceForCompany(
  evidence: StructuredEvidence | TenantEvidence | null | undefined,
  companyId: string | null | undefined,
): StructuredEvidence {
  if (!evidence) return blankEvidence(companyId);
  if (!evidenceBelongsToCompany(evidence, companyId)) return blankEvidence(companyId);
  return stampEvidenceTenant(evidence, companyId);
}

export function rejectCrossTenantMerge(
  left: StructuredEvidence | TenantEvidence | null | undefined,
  right: StructuredEvidence | TenantEvidence | null | undefined,
): boolean {
  const a = (left as TenantEvidence | undefined)?.companyId;
  const b = (right as TenantEvidence | undefined)?.companyId;
  return Boolean(a && b && a !== b);
}
