/**
 * Platform operational health presentation model.
 * Maps underlying technical states into operator-friendly summaries.
 */

export const OPERATIONAL_HEALTH_STATES = [
  "HEALTHY",
  "DEGRADED",
  "ATTENTION_REQUIRED",
  "OUTAGE",
  "UNKNOWN",
] as const;

export type OperationalHealthState = (typeof OPERATIONAL_HEALTH_STATES)[number];

export const OPERATIONAL_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export type OperationalSeverity = (typeof OPERATIONAL_SEVERITIES)[number];

export const OPERATIONAL_ERROR_CATEGORIES = [
  "AUTHENTICATION",
  "AUTHORIZATION",
  "PROVIDER",
  "RATE_LIMIT",
  "CONFIGURATION",
  "DATA",
  "TIMEOUT",
  "INTERNAL",
  "SECURITY_POLICY",
  "UNKNOWN",
] as const;

export type OperationalErrorCategory = (typeof OPERATIONAL_ERROR_CATEGORIES)[number];

export type OperationalSubsystemId =
  | "api"
  | "database"
  | "portal"
  | "platform"
  | "microsoft"
  | "google_drive"
  | "xero"
  | "automation"
  | "stripe"
  | "knowledge"
  | "outbound_email"
  | "mcp";

export type OperationalSubsystemHealth = {
  id: OperationalSubsystemId;
  label: string;
  state: OperationalHealthState;
  severity: OperationalSeverity;
  summary: string;
  detail?: string | null;
  lastCheckedAt: string;
  metrics?: Record<string, number | string | boolean | null>;
};

export type OperationalIncident = {
  id: string;
  severity: OperationalSeverity;
  companyId: string | null;
  companyName: string | null;
  subsystem: OperationalSubsystemId | "platform";
  category: OperationalErrorCategory;
  title: string;
  summary: string;
  occurrenceCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  recommendedAction: string;
  resolved: boolean;
  href: string | null;
};

export type CompanyOperationalSummary = {
  companyId: string;
  companyName: string;
  companySlug: string;
  overallState: OperationalHealthState;
  connectorIssues: number;
  billingIssues: number;
  automationFailures: number;
  knowledgeSyncIssues: number;
  authSecuritySignals: number;
  lastSuccessfulActivityAt: string | null;
  attentionCount: number;
};

export type PlatformOperationalHealth = {
  checkedAt: string;
  overallState: OperationalHealthState;
  overallSeverity: OperationalSeverity;
  subsystems: OperationalSubsystemHealth[];
  incidents: OperationalIncident[];
  companySummaries: CompanyOperationalSummary[];
  schedulerHeartbeats: Array<{
    key: string;
    label: string;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    state: OperationalHealthState;
  }>;
  automationProcessingMode: "queue" | "http_fallback";
  openFinancialExceptions: number;
  permissionDenialsLast24h: number;
  usageAnomalyFlags: string[];
};

const STATE_RANK: Record<OperationalHealthState, number> = {
  OUTAGE: 0,
  ATTENTION_REQUIRED: 1,
  DEGRADED: 2,
  UNKNOWN: 3,
  HEALTHY: 4,
};

const SEVERITY_RANK: Record<OperationalSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

export function worstOperationalState(
  states: OperationalHealthState[],
): OperationalHealthState {
  if (states.length === 0) return "UNKNOWN";
  return states.reduce((worst, state) =>
    STATE_RANK[state] < STATE_RANK[worst] ? state : worst,
  );
}

export function worstOperationalSeverity(
  severities: OperationalSeverity[],
): OperationalSeverity {
  if (severities.length === 0) return "INFO";
  return severities.reduce((worst, severity) =>
    SEVERITY_RANK[severity] < SEVERITY_RANK[worst] ? severity : worst,
  );
}

export function mapAttentionSeverityToOperational(
  severity: "critical" | "warning" | "info",
): OperationalSeverity {
  if (severity === "critical") return "CRITICAL";
  if (severity === "warning") return "WARNING";
  return "INFO";
}

export function mapOperationalSeverityToAttention(
  severity: OperationalSeverity,
): "critical" | "warning" | "info" {
  if (severity === "CRITICAL") return "critical";
  if (severity === "WARNING") return "warning";
  return "info";
}

export function operationalStateFromBoolean(input: {
  healthy?: boolean;
  degraded?: boolean;
  outage?: boolean;
  unknown?: boolean;
}): OperationalHealthState {
  if (input.outage) return "OUTAGE";
  if (input.degraded) return "DEGRADED";
  if (input.healthy) return "HEALTHY";
  if (input.unknown) return "UNKNOWN";
  return "ATTENTION_REQUIRED";
}
