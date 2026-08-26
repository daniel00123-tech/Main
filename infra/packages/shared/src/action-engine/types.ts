/**
 * Generic INFRA Action Engine contracts.
 * Provider-agnostic — Xero is the first implementation.
 */

export type RiskClassification =
  | "low_risk"
  | "write"
  | "financial_action"
  | "external_send"
  | "delete";

export type ActionPlanStatus =
  | "draft"
  | "validated"
  | "awaiting_confirmation"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "completed"
  | "partial_failure"
  | "failed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "plan_stale"
  | "execution_uncertain";

export type ConfirmationStatus = "not_required" | "awaiting" | "confirmed";

export type ApprovalStatus = "not_required" | "pending" | "approved" | "denied";

export type ActionTargetValidationResult =
  | "valid"
  | "not_found"
  | "wrong_company"
  | "wrong_type"
  | "wrong_status"
  | "already_credited"
  | "zero_outstanding"
  | "currency_mismatch"
  | "ambiguous";

export type ActionTarget = {
  targetId: string;
  targetType: string;
  humanRef: string;
  currentState: Record<string, unknown>;
  proposedState: Record<string, unknown>;
  amount?: number | null;
  currencyCode?: string | null;
  validation: ActionTargetValidationResult;
  validationDetail?: string | null;
};

export type PermissionDecision = {
  allowed: boolean;
  reasonCode:
    | "allowed"
    | "permission_denied"
    | "approval_required"
    | "confirmation_required"
    | "writes_disabled"
    | "destructive_disabled"
    | "connector_disconnected"
    | "company_suspended"
    | "scope_missing"
    | "identity_disabled";
  requiredPermission: string;
  riskClass: RiskClassification;
  writesSupported: boolean;
  writesEnabled: boolean;
  financialWritesEnabled: boolean;
  destructiveWritesEnabled: boolean;
  requiresConfirmation: boolean;
  requiresApproval: boolean;
  message?: string;
};

export type FinancialImpact = {
  currencyCode: string | null;
  totalAmount: number | null;
  direction: "credit" | "debit" | "neutral" | null;
  itemCount: number;
};

export type ActionDefinition = {
  action: string;
  provider: string;
  riskClass: RiskClassification;
  requiredPermission: string;
  usesExecutionPlan: boolean;
  requiresLiveValidation: boolean;
  billingOperation: string;
  auditEvent: string;
};

export type ActionPlanRecord = {
  id: string;
  companyId: string;
  connectorInstanceId: string | null;
  provider: string;
  requestedAction: string;
  status: ActionPlanStatus;
  idempotencyKey: string | null;
  actor: string;
  sourceClient: string | null;
  correlationId: string | null;
  interactionId: string | null;
  targets: ActionTarget[];
  summary: string | null;
  financialImpact: FinancialImpact | null;
  permissionDecision: PermissionDecision | null;
  riskClass: RiskClassification;
  confirmationStatus: ConfirmationStatus;
  approvalStatus: ApprovalStatus;
  planFingerprint: string | null;
  stateVersion: number;
  expiresAt: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  createdAt: string;
  updatedAt: string;
  executedAt: string | null;
};

export type ActionPlanCreateInput = {
  companyId: string;
  connectorInstanceId?: string | null;
  provider?: string;
  requestedAction: string;
  idempotencyKey?: string | null;
  actor: string;
  sourceClient?: string | null;
  correlationId?: string | null;
  interactionId?: string | null;
  targets: ActionTarget[];
  summary?: string;
  financialImpact?: FinancialImpact | null;
  permissionDecision: PermissionDecision;
  riskClass: RiskClassification;
  expiresInMinutes?: number;
};

export type MatchConfidence = "exact" | "high" | "ambiguous" | "no_match";

export type RemittanceAllocationCandidate = {
  invoiceId: string;
  invoiceNumber: string;
  contactName: string;
  amountDue: number;
  currencyCode: string;
  confidence: MatchConfidence;
  reason: string;
};

export const ACTION_PLAN_DEFAULT_TTL_MINUTES = 30;
export const ACTION_PLAN_MAX_BATCH_ITEMS = 20;
