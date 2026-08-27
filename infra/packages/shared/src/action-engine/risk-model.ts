/**
 * Formal Xero Action Engine risk classification.
 * Server-side enforcement is authoritative — UI confirmation alone is insufficient.
 */

import type { RiskClassification } from "./types";

/** Product-facing risk levels mapped to confirmation requirements. */
export type ActionRiskLevel =
  | "READ"
  | "DRAFT_WRITE"
  | "ACCOUNTING_COMMITMENT"
  | "EXTERNAL_COMMUNICATION"
  | "MONEY_MOVEMENT"
  | "DESTRUCTIVE";

export type ActionRiskProfile = {
  level: ActionRiskLevel;
  /** Legacy risk class used in plans and billing. */
  riskClass: RiskClassification;
  requiredPermission: string;
  requiresConfirmation: boolean;
  requiresEnhancedConfirmation: boolean;
  requiresApproval: boolean;
  financialWriteRequired: boolean;
  readBackVerificationRequired: boolean;
  idempotencyMandatory: boolean;
  executionExpiryApplies: boolean;
  /** Human-readable warning shown in confirmation preview. */
  warning?: string;
};

const PROFILES: Record<ActionRiskLevel, Omit<ActionRiskProfile, "requiredPermission">> = {
  READ: {
    level: "READ",
    riskClass: "low_risk",
    requiresConfirmation: false,
    requiresEnhancedConfirmation: false,
    requiresApproval: false,
    financialWriteRequired: false,
    readBackVerificationRequired: false,
    idempotencyMandatory: false,
    executionExpiryApplies: false,
  },
  DRAFT_WRITE: {
    level: "DRAFT_WRITE",
    riskClass: "financial_action",
    requiresConfirmation: true,
    requiresEnhancedConfirmation: false,
    requiresApproval: false,
    financialWriteRequired: true,
    readBackVerificationRequired: true,
    idempotencyMandatory: true,
    executionExpiryApplies: true,
  },
  ACCOUNTING_COMMITMENT: {
    level: "ACCOUNTING_COMMITMENT",
    riskClass: "financial_action",
    requiresConfirmation: true,
    requiresEnhancedConfirmation: true,
    requiresApproval: false,
    financialWriteRequired: true,
    readBackVerificationRequired: true,
    idempotencyMandatory: true,
    executionExpiryApplies: true,
    warning: "This action commits an accounting entry and cannot be undone without a reversing document.",
  },
  EXTERNAL_COMMUNICATION: {
    level: "EXTERNAL_COMMUNICATION",
    riskClass: "external_send",
    requiresConfirmation: true,
    requiresEnhancedConfirmation: true,
    requiresApproval: false,
    financialWriteRequired: true,
    readBackVerificationRequired: true,
    idempotencyMandatory: true,
    executionExpiryApplies: true,
    warning: "This action sends a document to an external recipient.",
  },
  MONEY_MOVEMENT: {
    level: "MONEY_MOVEMENT",
    riskClass: "financial_action",
    requiresConfirmation: true,
    requiresEnhancedConfirmation: true,
    requiresApproval: true,
    financialWriteRequired: true,
    readBackVerificationRequired: true,
    idempotencyMandatory: true,
    executionExpiryApplies: true,
    warning: "This action records or allocates a payment in Xero.",
  },
  DESTRUCTIVE: {
    level: "DESTRUCTIVE",
    riskClass: "delete",
    requiresConfirmation: true,
    requiresEnhancedConfirmation: true,
    requiresApproval: true,
    financialWriteRequired: true,
    readBackVerificationRequired: true,
    idempotencyMandatory: true,
    executionExpiryApplies: true,
    warning: "This action voids or removes an accounting document.",
  },
};

/** Maps Xero action identifiers to risk profiles. */
export const XERO_ACTION_RISK_MAP: Record<string, ActionRiskLevel> = {
  "xero.invoices.create": "DRAFT_WRITE",
  "xero.invoices.update": "DRAFT_WRITE",
  "xero.invoices.approve": "ACCOUNTING_COMMITMENT",
  "xero.invoices.send": "EXTERNAL_COMMUNICATION",
  "xero.invoices.create_approve_send": "EXTERNAL_COMMUNICATION",
  "xero.credit_notes.create_draft": "DRAFT_WRITE",
  "xero.credit_notes.create": "ACCOUNTING_COMMITMENT",
  "xero.credit_notes.approve": "ACCOUNTING_COMMITMENT",
  "xero.credit_notes.allocate": "ACCOUNTING_COMMITMENT",
  "xero.bills.create": "DRAFT_WRITE",
  "xero.bills.approve": "ACCOUNTING_COMMITMENT",
  "xero.payments.allocate": "MONEY_MOVEMENT",
  "xero.contacts.create": "DRAFT_WRITE",
  "xero.invoice.void": "DESTRUCTIVE",
  "xero.credit_note.void": "DESTRUCTIVE",
  "xero.bill.void": "DESTRUCTIVE",
};

export function actionRiskProfile(action: string): ActionRiskProfile {
  const level = XERO_ACTION_RISK_MAP[action] ?? "ACCOUNTING_COMMITMENT";
  const base = PROFILES[level];
  return { ...base, requiredPermission: action };
}

export function riskLevelForAction(action: string): ActionRiskLevel {
  return XERO_ACTION_RISK_MAP[action] ?? "ACCOUNTING_COMMITMENT";
}
