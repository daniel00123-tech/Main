export const DAILY_IMPROVEMENT_TIMEZONE = "Europe/London";
export const DAILY_IMPROVEMENT_CONFIG_ID = "platform";
export const EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID = "aut_b00ab912-845b-49b4-9609-cbedeeea6ddf";

export const QA_HOUR = 16;
export const QA_MINUTE = 30;
export const REPORT_HOUR = 17;
export const REPORT_MINUTE = 0;
export const ENGINEERING_HOUR = 17;
export const ENGINEERING_MINUTE = 5;

export const MAX_ENGINEERING_JOBS_PER_CYCLE = 5;
export const MAX_DEPLOYS_PER_CYCLE = 1;
export const MAX_SEQUENCE_TURNS = 8;

export const QUALITY_TRAFFIC_CLASS = "QUALITY" as const;
export const ENGINEERING_TRAFFIC_CLASS = "ENGINEERING" as const;
export const TEST_TRAFFIC_CLASS = "TEST" as const;
export const CUSTOMER_TRAFFIC_CLASS = "CUSTOMER_REQUEST" as const;

export const NON_CUSTOMER_TRAFFIC = new Set([
  "TEST",
  "SHADOW",
  "QUALITY",
  "INTERNAL",
  "AUTOMATION",
  "HEALTH",
  "ENGINEERING",
]);

export const CHANNELS = ["whatsapp", "portal_chat", "chatgpt", "claude"] as const;
export type DailyImprovementChannel = (typeof CHANNELS)[number] | string;

export const COMPANY_LABELS: Record<string, string> = {
  co_el: "EL",
  co_caddington: "Caddington",
  co_ht: "HT",
};

export const QUALITY_SCORE_DIMENSIONS = [
  "INTENT",
  "TOOL_SELECTION",
  "EXACT_TOOL",
  "RBAC",
  "GROUNDING",
  "FIRST_ANSWER",
  "COMPLETENESS",
  "MEMORY",
  "FOLLOW_UP",
  "NATURALNESS",
  "EFFICIENCY",
  "HALLUCINATION",
  "RELIABILITY",
  "USER_EFFORT",
] as const;

export type QualityScoreDimension = (typeof QUALITY_SCORE_DIMENSIONS)[number];

export const FAILURE_CATEGORIES = [
  "EXPECTED_TOOL_MISSING",
  "WRONG_TOOL",
  "WRONG_CAPABILITY",
  "EMAIL_TO_XERO",
  "XERO_TO_KNOWLEDGE",
  "LIST_VS_SEARCH",
  "KNOWLEDGE_VS_CATALOGUE",
  "FRESH_DATA_NOT_FETCHED",
  "UNNECESSARY_TOOL",
  "DUPLICATE_TOOL",
  "EVIDENCE_DROPPED",
  "STALE_EVIDENCE",
  "FIRST_ANSWER_INCOMPLETE",
  "CONTEXT_LOST",
  "USER_HAD_TO_REPEAT",
  "CORRECTION_NOT_REPLANNED",
  "FALSE_NO_RESULTS",
  "FALSE_PERMISSION_DENIAL",
  "PERMISSION_LEAK",
  "SYNTHESIS_CONTRADICTION",
  "GENERIC_RETRY_AFTER_SUCCESS",
  "UPSTREAM_FAILURE",
  "PROVIDER_FAILURE",
  "HALLUCINATION",
  "NO_FINAL_RESPONSE",
  "BILLING_ERROR",
  "LATENCY_OUTLIER",
  "CROSS_TENANT_RISK",
  "MIXED_MULTI_TOOL",
  "XERO_EXACT_TOOL_SELECTION",
  "MANUAL_INFRASTRUCTURE_ACTION",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type DailyImprovementSeverity = (typeof SEVERITIES)[number];

export const DAILY_IMPROVEMENT_CONTRACT = {
  cursorInCustomerPath: false,
  requiresHumanApproval: false,
  autoPromoteProvider: false,
  autoDeployFromSingleFailure: false,
  autoDeployAfterFullGates: true,
  reproduceBeforeFix: true,
  genericFixesOnly: true,
  noRbacWeakening: true,
  noSecretRotation: true,
  noDestructiveMigrations: true,
  noWritePermissionExpansion: true,
  noInferredPricingChange: true,
  qaCustomerChargeCents: 0,
  engineeringCustomerChargeCents: 0,
  elCustomerRequestCents: 3,
  protectedKnowledgeAutomationId: EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID,
} as const;

export const SEEDED_CLUSTERS = [
  {
    clusterKey: "MIXED_MULTI_TOOL",
    category: "MIXED_MULTI_TOOL" as FailureCategory,
    title: "Mixed multi-tool planning under-selects a second capability",
    severity: "HIGH" as DailyImprovementSeverity,
    currentBehaviour:
      "Compound asks that name two live capabilities sometimes execute only one family (tool score 92, mixed multi-tool 80).",
    expectedBehaviour:
      "When the tenant catalogue contains two requested capability families, the planner must run both and keep the answer grounded in both result sets.",
    rootCause:
      "Multi-capability detection still requires a linguistic conjunction even after two families are already recognised.",
    proposedFix:
      "Treat two detected capability families as a multi-tool plan. Do not require tenant-specific phrases.",
    risk: "LOW — routing only; no write expansion; no pricing change.",
    testsRequired:
      "Capability-family detection, mixed EMAIL+ACCOUNTING without conjunction, sales-process must stay single-scope, tenant isolation.",
    expectedBenefit: "Raise mixed multi-tool and tool-selection toward the canary gates without promoting OpenAI.",
  },
  {
    clusterKey: "XERO_EXACT_TOOL_SELECTION",
    category: "XERO_EXACT_TOOL_SELECTION" as FailureCategory,
    title: "Xero exact-tool family selection misses reports and outstanding invoices",
    severity: "HIGH" as DailyImprovementSeverity,
    currentBehaviour:
      "Exact-family score 96. Outstanding invoices and P&L/report asks collapse to the sales-summary family.",
    expectedBehaviour:
      "Invoice search/get, contacts, and report capabilities must map to the matching INFRA Xero tool family.",
    rootCause: "Capability detector treats most accounting language as ACCOUNTING_SALES.",
    proposedFix:
      "Generic accounting-family routing: outstanding/unpaid → invoice search; P&L/aged/balance sheet → reports; named contact → contacts.",
    risk: "LOW — read-path routing only.",
    testsRequired: "Exact-family regression for invoice search, invoice get, reports, contacts, sales summary.",
    expectedBenefit: "Lift exact-family toward ≥98 without enabling OpenAI canary.",
  },
] as const;
