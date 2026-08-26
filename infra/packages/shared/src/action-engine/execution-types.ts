/** Durable financial execution lifecycle — separate from plan and JSON-RPC ids. */

export type ActionExecutionStatus =
  | "not_attempted"
  | "executing"
  | "succeeded"
  | "failed"
  | "uncertain";

export type ActionVerificationStatus =
  | "not_required"
  | "pending"
  | "verified"
  | "verification_failed"
  | "uncertain";

export type ActionExecutionRecord = {
  id: string;
  planId: string;
  companyId: string;
  executionKey: string;
  provider: string;
  requestedAction: string;
  status: ActionExecutionStatus;
  verificationStatus: ActionVerificationStatus | null;
  xeroResourceId: string | null;
  humanReference: string | null;
  amount: number | null;
  currencyCode: string | null;
  resultJson: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Minimum OAuth scope for first acceptance: draft ACCREC invoice only. */
export const XERO_SCOPES_DRAFT_INVOICE = ["accounting.invoices"] as const;

export const ACCEPTANCE_TEST_DRAFT_INVOICE = {
  reference: "INFRA-ACCEPTANCE-TEST",
  description: "INFRA Xero Write Acceptance Test",
  quantity: 1,
  unitAmount: 1.0,
  type: "ACCREC" as const,
  status: "DRAFT" as const,
};
