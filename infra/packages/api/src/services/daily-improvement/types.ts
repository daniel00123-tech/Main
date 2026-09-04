import type {
  DailyImprovementSeverity,
  FailureCategory,
  QualityScoreDimension,
} from "./constants";

export type DailyImprovementRunKind = "QA" | "REPORT" | "ENGINEERING" | "BOOTSTRAP" | "CORRECTED_REPORT";

export type QualityFinding = {
  category: FailureCategory | string;
  severity: DailyImprovementSeverity;
  confidence: number;
  expectedBehavior: string;
  actualBehavior: string;
  evidenceReference: string;
  rootCauseHypothesis: string;
  userImpact: string;
};

export type IssueLifecycle = "NEW" | "STILL_OPEN" | "FIXED" | "REGRESSED";

export type EngineeringJobStatus =
  | "QUEUED"
  | "CLAIMED"
  | "REPRODUCING"
  | "NOT_REPRODUCED"
  | "FIXING"
  | "TESTING"
  | "READY_TO_DEPLOY"
  | "DEPLOYED"
  | "ROLLED_BACK"
  | "REJECTED"
  | "CARRIED";

export type DailyImprovementInteraction = {
  id: string;
  interactionId: string;
  customerRequestId: string | null;
  companyId: string;
  userId: string | null;
  role: string | null;
  channel: string;
  conversationId: string | null;
  createdAt: string;
  userMessage: string | null;
  provider: string | null;
  model: string | null;
  providerMode: string | null;
  availableCapabilities: string[];
  toolsRequested: string[];
  toolsExecuted: string[];
  evidenceRefs: Array<Record<string, unknown>>;
  assistantAnswer: string | null;
  terminalState: string | null;
  latencyMs: number | null;
  customerChargeCents: number;
  providerCostCents: number | null;
  qualityResult: string | null;
  correlationId: string | null;
  trafficClass: string;
  sourceClient: string | null;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  toolsExecuted?: string[];
  createdAt?: string;
};

export type DimensionScores = Record<QualityScoreDimension, number>;

export type DailyImprovementEvaluation = {
  id: string;
  interactionId: string;
  conversationId: string | null;
  runId: string | null;
  companyId: string;
  channel: string | null;
  overallScore: number;
  scores: DimensionScores;
  failureCategories: FailureCategory[];
  severity: DailyImprovementSeverity | null;
  notes: string | null;
  evaluatorModel: string | null;
  evaluatorKind: "heuristic" | "openai" | "merged";
  trafficClass: "QUALITY";
  customerChargeCents: 0;
  createdAt: string;
  findings: QualityFinding[];
  interactionTrafficClass?: string | null;
};

export type DailyImprovementCluster = {
  id: string;
  runId: string | null;
  clusterKey: string;
  category: FailureCategory | string;
  title: string;
  severity: DailyImprovementSeverity;
  interactionCount: number;
  tenantCount: number;
  companyIds: string[];
  currentBehaviour: string | null;
  expectedBehaviour: string | null;
  rootCause: string | null;
  proposedFix: string | null;
  risk: string | null;
  testsRequired: string | null;
  expectedBenefit: string | null;
  status: string;
  exampleIds?: string[];
  channels?: string[];
  lifecycle?: IssueLifecycle;
};

export type DailyImprovementIssue = {
  id: string;
  clusterId: string | null;
  runId: string | null;
  title: string;
  category: string;
  severity: DailyImprovementSeverity;
  status: string;
  priorityScore: number;
  affectedInteractions: number;
  affectedTenants: number;
};

export type EngineeringJobSpec = {
  clusterKey: string;
  title: string;
  severity: DailyImprovementSeverity;
  category: string;
  companyIds: string[];
  reproduceFirst: true;
  genericFixOnly: true;
  forbidden: {
    phrasePatches: true;
    rbacWeakening: true;
    secretRotation: true;
    destructiveMigrations: true;
    writePermissionExpansion: true;
    inferredPricingChange: true;
    providerPromotion: true;
    cursorInCustomerPath: true;
  };
  requiredGates: string[];
  testsRequired: string;
  currentBehaviour: string;
  expectedBehaviour: string;
};

export type DailyReportPayload = {
  date: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  recipients: string[];
  summary: DailyReportSummary;
};

export type LatencyStats = {
  median: number | null;
  p95: number | null;
  max: number | null;
};

export type MetricTrend = {
  today: number | null;
  yesterday: number | null;
  weekAverage: number | null;
};

export type CustomerChatSummary = {
  company: string;
  user: string;
  channel: string;
  topic: string;
  turns: number;
  qualityScore: number | null;
  hasIssue: boolean;
  outcome: string;
  conversationId: string | null;
};

export type DailyReportSummary = {
  totalChats: number;
  totalInteractions: number;
  customerInteractions: number;
  testInteractions: number;
  shadowInteractions: number;
  automationInternalInteractions: number;
  customerConversations: number;
  byTrafficClass: Record<string, number>;
  byChannel: Record<string, number>;
  byCompany: Record<string, number>;
  overallQuality: number | null;
  testQuality: number | null;
  correctAnswerRate: number | null;
  toolSelection: number | null;
  exactTool: number | null;
  firstAnswer: number | null;
  followUp: number | null;
  toolSelectionLabel: string;
  exactToolLabel: string;
  firstAnswerLabel: string;
  followUpLabel: string;
  userRepeatRate: number | null;
  hallucinations: number;
  hallucinationBreakdown: { customer: number; test: number; shadow: number; kinds: Record<string, number> };
  permissionIssues: number;
  expectedPermissionDenials: number;
  falsePermissionDenials: number;
  permissionLeaks: number;
  failures: number;
  customerFailures: number;
  testFailures: number;
  failureBreakdown: Record<string, number>;
  averageLatencyMs: number | null;
  latency: LatencyStats;
  customerLatency: LatencyStats;
  testLatency: LatencyStats;
  providerLatency: Record<string, LatencyStats>;
  providerComparison: Record<string, { count: number; quality: number | null }>;
  trends: Record<string, MetricTrend>;
  lifecycle: { newToday: string[]; stillOpen: string[]; fixedToday: string[]; regressed: string[] };
  chatSummaries: CustomerChatSummary[];
  issues: DailyImprovementCluster[];
  actionPlan: Array<{
    title: string;
    status: string;
    severity: string;
    clusterKey: string;
    affected: number;
    channels: string[];
    tenants: string[];
    examples: string[];
    currentBehaviour: string;
    expectedBehaviour: string;
    rootCause: string;
    proposedFix: string;
    testsRequired: string;
    risk: string;
  }>;
  yesterdaysFixes: Array<Record<string, unknown>>;
  engineeringStart: string;
  corrected?: boolean;
  sanity: { ok: boolean; reasons: string[] };
};
