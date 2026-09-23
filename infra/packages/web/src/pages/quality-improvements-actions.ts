import type { QualityLoopProposal } from "../api";

/** Android / iOS recommended minimum tap target. */
export const QUALITY_MOBILE_TAP_MIN_PX = 44;

export type QualityActionKind = "apply" | "accept" | "reject" | "rollback" | "evidence";

export type QualityProposalLite = Pick<
  QualityLoopProposal,
  "id" | "status" | "risk" | "applyClass" | "engineeringRequired" | "autoApplyable"
>;

export function isPending(row: QualityProposalLite): boolean {
  return row.status === "pending_approval";
}

export function isPendingLowSafe(row: QualityProposalLite): boolean {
  return (
    isPending(row) &&
    row.risk === "low" &&
    row.applyClass === "AUTO_APPLY_SAFE" &&
    !row.engineeringRequired
  );
}

export function isAutoApplySafePending(row: QualityProposalLite): boolean {
  return isPending(row) && row.applyClass === "AUTO_APPLY_SAFE" && !row.engineeringRequired;
}

/** Engineering / informational / reconstructed items — Accept records review only. */
export function isReviewOnlyPending(row: QualityProposalLite): boolean {
  if (!isPending(row)) return false;
  if (row.engineeringRequired) return true;
  if (row.applyClass === "REQUIRES_ENGINEERING" || row.applyClass === "INFORMATIONAL") return true;
  return !isAutoApplySafePending(row);
}

export function pendingLowSafe(proposals: QualityProposalLite[]): QualityProposalLite[] {
  return proposals.filter(isPendingLowSafe);
}

export function pendingReviewOnly(proposals: QualityProposalLite[]): QualityProposalLite[] {
  return proposals.filter(isReviewOnlyPending);
}

export function pendingOpen(proposals: QualityProposalLite[]): QualityProposalLite[] {
  return proposals.filter(isPending);
}

export function bulkLowButton(proposals: QualityProposalLite[]): {
  enabled: boolean;
  showButton: boolean;
  count: number;
  reason: string | null;
} {
  const count = pendingLowSafe(proposals).length;
  if (count > 0) {
    return { enabled: true, showButton: true, count, reason: null };
  }
  return {
    enabled: false,
    showButton: false,
    count: 0,
    reason: "No LOW-risk items left to apply",
  };
}

export function acceptRemainingButton(proposals: QualityProposalLite[]): {
  enabled: boolean;
  showButton: boolean;
  count: number;
  hint: string;
} {
  const count = pendingReviewOnly(proposals).length;
  return {
    enabled: count > 0,
    showButton: count > 0,
    count,
    hint: "Records review. Does not auto-deploy TIER B/C or engineering changes.",
  };
}

export function itemPrimaryKind(row: QualityProposalLite): "apply" | "accept" | "rollback" | null {
  if (row.status === "canary" || row.status === "promoted") return "rollback";
  if (!isPending(row)) return null;
  return isAutoApplySafePending(row) ? "apply" : "accept";
}

export function itemPrimaryLabel(row: QualityProposalLite): string | null {
  const kind = itemPrimaryKind(row);
  if (kind === "apply") return "Apply";
  if (kind === "accept") return "Accept";
  if (kind === "rollback") return "Roll back";
  return null;
}

export function itemPrimaryHint(row: QualityProposalLite): string | null {
  const kind = itemPrimaryKind(row);
  if (kind === "apply") return "Applies this AUTO_APPLY_SAFE item to the quality canary. Idempotent if already applied.";
  if (kind === "accept") return "Records review. Does not auto-deploy this engineering or informational item.";
  if (kind === "rollback") return "Rolls this canary change back.";
  return null;
}

export function itemActionsEnabled(row: QualityProposalLite, busy: boolean): {
  apply: boolean;
  accept: boolean;
  reject: boolean;
  rollback: boolean;
  evidence: boolean;
} {
  const pending = isPending(row) && !busy;
  return {
    apply: pending && isAutoApplySafePending(row),
    accept: pending && !isAutoApplySafePending(row),
    reject: pending,
    rollback: !busy && (row.status === "canary" || row.status === "promoted"),
    evidence: !busy,
  };
}

export function defaultQualityFilter(proposals: QualityProposalLite[]): "all" | "pending" {
  return proposals.some(isPending) ? "pending" : "all";
}
