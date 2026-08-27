/**
 * Reusable execution-plan contract for multi-step financial connector actions.
 * Designed for Xero first; reusable for BigChange, Commusoft, etc.
 */

export type ExecutionPlanStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "executing"
  | "completed"
  | "partial_failure"
  | "failed"
  | "cancelled";

export type ExecutionPlanItemStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "skipped";

export type ExecutionPlanItem = {
  itemId: string;
  targetType: string;
  targetRef: string;
  currentState?: Record<string, unknown>;
  proposedChange: Record<string, unknown>;
  status: ExecutionPlanItemStatus;
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  xeroResourceId?: string;
};

export type ExecutionPlanRecord = {
  id: string;
  companyId: string;
  connectorInstanceId: string | null;
  provider: string;
  requestedAction: string;
  status: ExecutionPlanStatus;
  idempotencyKey: string | null;
  actor: string;
  correlationId: string | null;
  interactionId: string | null;
  items: ExecutionPlanItem[];
  summary?: string;
  requiredApproval: boolean;
  approvalStatus?: "not_required" | "pending" | "approved" | "denied";
  createdAt: string;
  updatedAt: string;
  executedAt?: string | null;
};

export type ExecutionPlanCreateInput = {
  companyId: string;
  connectorInstanceId?: string | null;
  provider?: string;
  requestedAction: string;
  idempotencyKey?: string | null;
  actor: string;
  correlationId?: string | null;
  interactionId?: string | null;
  items: Array<Omit<ExecutionPlanItem, "status" | "result" | "errorCode" | "errorMessage">>;
  summary?: string;
  requiredApproval?: boolean;
};

/** Default bounds for Xero read operations exposed to AI tools. */
export const XERO_DATA_BOUNDS = {
  maxListResults: 100,
  defaultListResults: 25,
  /** Upper bound for paginated fetches before truncation warnings. */
  maxPaginationRecords: 500,
  maxReportMonths: 24,
  maxDateRangeDays: 366,
  maxBatchWriteItems: 20,
} as const;
