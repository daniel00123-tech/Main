/** Derived usage outcome. Does not mutate stored audit rows. */

export type UsageOutcomeKind =
  | "SUCCESS"
  | "SUCCESS_NO_RESULTS"
  | "PERMISSION_DENIED"
  | "UPSTREAM_FAILURE"
  | "TIMEOUT"
  | "APPLICATION_ERROR"
  | "TOOL_NOT_EXPOSED"
  | "AUTH_IDENTITY"
  | "DUPLICATE_RETRY"
  | "UNKNOWN_FAILURE";

export type UsageFailureCategory =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "MISSING_CAPABILITY"
  | "VALIDATION"
  | "UPSTREAM_API"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "INSUFFICIENT_CREDIT"
  | "INFRA_INTERNAL"
  | "USER_INPUT"
  | "UNKNOWN";

export type UsageHistoricalHint =
  | "xero_tool_mapping"
  | "knowledge_timeout"
  | "isolation_probe"
  | null;

export type UsageOutcome = {
  kind: UsageOutcomeKind;
  /** Counts against operational success (real breakage / timeout / app error). */
  operationalFailure: boolean;
  expectedDenial: boolean;
  noResults: boolean;
  failureCategory: UsageFailureCategory | null;
  historicalHint: UsageHistoricalHint;
};

export type UsageOutcomeInput = {
  success?: boolean;
  settlementStatus?: string | null;
  toolName?: string | null;
  action?: string | null;
  durationMs?: number | null;
  recordedAt?: string | null;
  actorEmail?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Xero company-MCP tool-name mapping shipped 2026-09-02. */
export const XERO_TOOL_MAPPING_FIXED_AT = "2026-09-02T00:00:00.000Z";

export function classifyUsageOutcome(input: UsageOutcomeInput): UsageOutcome {
  const meta = input.metadata ?? {};
  const denied =
    input.settlementStatus === "denied" ||
    meta.denied === true ||
    meta.result === "permission_denied" ||
    meta.billingStatus === "denied";
  const empty =
    meta.accessOutcome === "empty_result" ||
    meta.result === "empty_result" ||
    /no matching .+ (records|invoices|emails)/i.test(joinedText(meta));
  const text = joinedText(meta).toLowerCase().replace(/[’‘]/g, "'");
  const tool = `${input.toolName ?? ""} ${input.action ?? ""}`.toLowerCase();
  const historicalHint = historicalHintFor(input, tool);

  if (input.success !== false) {
    if (empty) {
      return {
        kind: "SUCCESS_NO_RESULTS",
        operationalFailure: false,
        expectedDenial: false,
        noResults: true,
        failureCategory: null,
        historicalHint: null,
      };
    }
    return {
      kind: "SUCCESS",
      operationalFailure: false,
      expectedDenial: false,
      noResults: false,
      failureCategory: null,
      historicalHint: null,
    };
  }

  if (denied) {
    return {
      kind: "PERMISSION_DENIED",
      operationalFailure: false,
      expectedDenial: true,
      noResults: false,
      failureCategory: "PERMISSION",
      historicalHint: null,
    };
  }

  if (isProbeActor(input.actorEmail)) {
    return {
      kind: "APPLICATION_ERROR",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "INFRA_INTERNAL",
      historicalHint: "isolation_probe",
    };
  }

  if ((input.durationMs ?? 0) >= 20_000 || text.includes("timeout") || text.includes("timed out")) {
    return {
      kind: "TIMEOUT",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "TIMEOUT",
      historicalHint,
    };
  }

  if (
    text.includes("tool not found") ||
    text.includes("unknown tool") ||
    text.includes("not exposed") ||
    text.includes("wrong_tool")
  ) {
    return {
      kind: "TOOL_NOT_EXPOSED",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "MISSING_CAPABILITY",
      historicalHint,
    };
  }

  if (text.includes("insufficient credit") || text.includes("402")) {
    return {
      kind: "APPLICATION_ERROR",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "INSUFFICIENT_CREDIT",
      historicalHint: null,
    };
  }

  if (text.includes("401") || text.includes("unauthor") || text.includes("oauth")) {
    return {
      kind: "AUTH_IDENTITY",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "AUTHENTICATION",
      historicalHint: null,
    };
  }

  if (text.includes("502") || text.includes("503") || text.includes("upstream") || text.includes("couldn't reach")) {
    return {
      kind: "UPSTREAM_FAILURE",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "UPSTREAM_API",
      historicalHint,
    };
  }

  if (tool.includes("xero") && recordedBefore(input.recordedAt, XERO_TOOL_MAPPING_FIXED_AT)) {
    return {
      kind: "UPSTREAM_FAILURE",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "UPSTREAM_API",
      historicalHint: "xero_tool_mapping",
    };
  }

  if (tool.includes("knowledge") && (input.durationMs ?? 0) >= 15_000) {
    return {
      kind: "TIMEOUT",
      operationalFailure: true,
      expectedDenial: false,
      noResults: false,
      failureCategory: "TIMEOUT",
      historicalHint: historicalHint ?? "knowledge_timeout",
    };
  }

  return {
    kind: "UNKNOWN_FAILURE",
    operationalFailure: true,
    expectedDenial: false,
    noResults: false,
    failureCategory: "UNKNOWN",
    historicalHint,
  };
}

export function summarizeUsageOutcomes(rows: UsageOutcomeInput[]): {
  requests: number;
  successful: number;
  failed: number;
  denied: number;
  operationalFailed: number;
  noResults: number;
  rawSuccessRate: number | null;
  operationalSuccessRate: number | null;
  customerMeaningfulSuccessRate: number | null;
} {
  let successful = 0;
  let failed = 0;
  let denied = 0;
  let operationalFailed = 0;
  let noResults = 0;
  for (const row of rows) {
    const outcome = classifyUsageOutcome(row);
    if (row.success !== false) successful += 1;
    else failed += 1;
    if (outcome.expectedDenial) denied += 1;
    if (outcome.operationalFailure) operationalFailed += 1;
    if (outcome.noResults) noResults += 1;
  }
  const requests = rows.length;
  const operationalDenom = requests - denied;
  const customerOk = successful;
  return {
    requests,
    successful,
    failed,
    denied,
    operationalFailed,
    noResults,
    rawSuccessRate: requests > 0 ? successful / requests : null,
    operationalSuccessRate: operationalDenom > 0 ? (operationalDenom - operationalFailed) / operationalDenom : null,
    customerMeaningfulSuccessRate: operationalDenom > 0 ? customerOk / operationalDenom : null,
  };
}

function joinedText(meta: Record<string, unknown>): string {
  return [meta.reason, meta.error, meta.message, meta.publicError, meta.code, meta.result, meta.accessOutcome]
    .filter((value) => typeof value === "string")
    .join(" ");
}

function isProbeActor(email?: string | null): boolean {
  const value = (email ?? "").toLowerCase();
  return value.includes("probe") || value.includes("isolation") || value.includes("routing probe");
}

function recordedBefore(recordedAt: string | null | undefined, iso: string): boolean {
  if (!recordedAt) return false;
  return recordedAt < iso;
}

function historicalHintFor(input: UsageOutcomeInput, tool: string): UsageHistoricalHint {
  if (isProbeActor(input.actorEmail)) return "isolation_probe";
  if (tool.includes("xero") && recordedBefore(input.recordedAt, XERO_TOOL_MAPPING_FIXED_AT)) {
    return "xero_tool_mapping";
  }
  if (tool.includes("knowledge") && (input.durationMs ?? 0) >= 15_000) return "knowledge_timeout";
  return null;
}
