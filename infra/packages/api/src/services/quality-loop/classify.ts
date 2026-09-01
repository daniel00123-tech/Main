import type { ProposalKind, ProposalRisk } from "./types";
import { AUTO_APPLY_KINDS, HIGH_RISK_PROPOSAL_KEYS } from "./types";

export type ApplyClass = "AUTO_APPLY_SAFE" | "REQUIRES_ENGINEERING" | "INFORMATIONAL";
export type RecurrenceClass = "HISTORICAL" | "CURRENT" | "RECURRENT";
export type ApplyTier = "A" | "B" | "C";

export function classifyApplyClass(input: {
  kind: string;
  risk: string;
  autoApplyable: boolean;
  engineeringRequired: boolean;
  patchPaths?: string[];
}): ApplyClass {
  if (input.engineeringRequired || input.kind === "engineering_change") return "REQUIRES_ENGINEERING";
  if (isTierCPath(input.patchPaths ?? []) || input.risk === "high") return "REQUIRES_ENGINEERING";
  if (input.autoApplyable && AUTO_APPLY_KINDS.includes(input.kind as ProposalKind) && input.risk !== "high") {
    return "AUTO_APPLY_SAFE";
  }
  return "INFORMATIONAL";
}

export function classifyApplyTier(input: {
  kind: string;
  risk: string;
  autoApplyable: boolean;
  engineeringRequired: boolean;
  patchPaths?: string[];
}): ApplyTier {
  if (isTierCPath(input.patchPaths ?? []) || isTierCKind(input.kind, input.risk)) return "C";
  if (classifyApplyClass(input) === "AUTO_APPLY_SAFE") return "A";
  return "B";
}

export function classifyRecurrence(input: {
  fingerprint: string;
  priorOccurrences: number;
  currentLive: boolean;
}): RecurrenceClass {
  if (input.priorOccurrences >= 2) return "RECURRENT";
  if (input.currentLive) return "CURRENT";
  return "HISTORICAL";
}

export function isTierCPath(paths: string[]): boolean {
  return paths.some((path) => {
    const hay = path.toLowerCase();
    return HIGH_RISK_PROPOSAL_KEYS.some((key) => hay.includes(key));
  });
}

function isTierCKind(kind: string, risk: string): boolean {
  if (kind === "engineering_change" && risk === "high") {
    return /auth|secret|oauth|stripe|rbac|billing|action.engine/i.test(kind);
  }
  return false;
}

export function canAutoApply(input: {
  kind: string;
  risk: ProposalRisk | string;
  autoApplyable: boolean;
  engineeringRequired: boolean;
  status: string;
  patchPaths?: string[];
}): boolean {
  if (input.status !== "pending_approval" && input.status !== "approved") return false;
  return classifyApplyClass(input) === "AUTO_APPLY_SAFE" && classifyApplyTier(input) === "A";
}
