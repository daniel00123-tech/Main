export const QUALITY_LOOP_EVALUATOR_VERSION = "quality-loop-whatsapp-v1";
export const QUALITY_LOOP_CHANNEL = "whatsapp" as const;
export const QUALITY_LOOP_CONFIG_ID = "platform";
export const CADDINGTON_COMPANY_ID = "co_caddington";
export const REVIEW_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const QUALITY_LOOP_TIMEZONE = "Europe/London";

export const QUALITY_DIMENSIONS = [
  "completeness",
  "latency",
  "grounding",
  "context",
  "tool_correctness",
  "permission_safety",
  "ux",
  "reliability",
] as const;

export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

export type QualityChannel = "whatsapp" | "chatgpt" | "claude" | "portal";

export type QualityLoopPhase = "daily" | "weekly";
export type QualityLoopKind = "daily" | "weekly" | "baseline" | "manual";

export type ProposalKind =
  | "prompt_tweak"
  | "planner_config"
  | "response_rule"
  | "threshold"
  | "ranking"
  | "suggested_actions"
  | "guidance_behaviour"
  | "engineering_change";

export type ProposalRisk = "low" | "medium" | "high";

export type ProposalStatus =
  | "proposed"
  | "rejected_pretest"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "deferred"
  | "applying"
  | "canary"
  | "promoted"
  | "rolled_back"
  | "failed_validation";

export type QualityFlagPolarity = "negative" | "positive";

export type QualityFlagCategory =
  | "silence"
  | "stuck"
  | "context_loss"
  | "raw_dump"
  | "missing_source_url"
  | "excessive_latency"
  | "wrong_tool"
  | "permission_ux"
  | "permission_denial_correct"
  | "rephrase"
  | "thanks"
  | "follow_up_used"
  | "first_tool_correct"
  | "fast_response"
  | "repeated_acks"
  | "button_context_lost"
  | "voice_failure"
  | "connector_error"
  | "greeting_slow"
  | "no_ack_on_slow_turn"
  | "first_visible_slow"
  | "rephrase_before_answer"
  | "outbound_meta_failure"
  | "ack_no_final"
  | "tool_timeout"
  | "broad_search"
  | "user_wait_over_60s"
  | "current_document_global_search"
  | "unrelated_document_after_context"
  | "answer_repeated_excerpt"
  | "more_detail_identical"
  | "malformed_extraction"
  | "unsolicited_pii"
  | "weak_result_confident"
  | "negative_result_feedback"
  | "topic_correction";

export interface QualityFlag {
  category: QualityFlagCategory;
  polarity: QualityFlagPolarity;
  severity: "low" | "medium" | "high";
  confidence: number;
  evidence: string;
}

export interface DimensionScore {
  score: number;
  evidence: string[];
}

export interface ConversationThread {
  companyId: string;
  conversationKey: string;
  interactionId?: string | null;
  userId?: string | null;
  channel: QualityChannel;
  userMessages: string[];
  assistantMessages: string[];
  acks: number;
  progressUpdates: number;
  buttonSelections: string[];
  voiceTranscript?: string | null;
  toolNames: string[];
  connectorErrors: string[];
  sourceUrls: string[];
  askedForSource: boolean;
  followUp: boolean;
  contextLost: boolean;
  rawLeak: boolean;
  permissionDenied: boolean;
  permissionDenialCorrect: boolean;
  acknowledgementMs: number | null;
  firstVisibleMs: number | null;
  totalMs: number | null;
  finalSent: boolean;
  acknowledgementSent: boolean;
  usageCostCents: number;
  qualitySignals: string[];
}

export interface ConversationEvaluation {
  companyId: string;
  conversationKey: string;
  interactionId?: string | null;
  channel: QualityChannel;
  dimensions: Record<QualityDimension, DimensionScore>;
  overallQualityScore: number;
  confidence: number;
  evaluatorVersion: string;
  flags: QualityFlag[];
  failed: boolean;
  permissionDenialCorrect: boolean;
  evidence: Record<string, unknown>;
}

export interface ChannelEvaluator {
  channel: QualityChannel;
  evaluate(thread: ConversationThread): ConversationEvaluation;
}

export interface QualityRuntimeConfig {
  version: number;
  prompts: {
    systemNote: string;
    sourceUrlGuidance: string;
    noRawDumpGuidance: string;
    contextFollowUpGuidance: string;
  };
  planner: {
    skipToolsOnCheapIntents: boolean;
    preferMemoryOnFollowUp: boolean;
    requireSourceUrlWhenAsked: boolean;
    blockWriteIntents: boolean;
  };
  responseRules: {
    maxChars: number;
    maxEmojis: number;
    stripRawJson: boolean;
    requireSourceUrlWhenAsked: boolean;
  };
  thresholds: {
    ackWarningMs: number;
    silenceMs: number;
    stuckMs: number;
    slowTotalMs: number;
  };
  ranking: {
    preferFirstToolCorrect: boolean;
  };
  suggestedActions: {
    preferOpenSource: boolean;
    maxButtons: number;
  };
  guidance: {
    mentionGuidanceSource: boolean;
    searchIncludesGuidance: boolean;
  };
}

export interface QualityConfigPatch {
  path: string;
  value: unknown;
}

export interface QualityProposalDraft {
  companyId: string | null;
  patternFingerprint: string;
  title: string;
  summary: string;
  kind: ProposalKind;
  risk: ProposalRisk;
  autoApplyable: boolean;
  engineeringRequired: boolean;
  patch: { patches: QualityConfigPatch[] };
  evidence: Record<string, unknown>;
  fingerprint: string;
}

export interface ReplayResult {
  beforeScore: number;
  afterScore: number;
  regressions: number;
  uatFailures: number;
  latencyDeltaMs: number;
  costDeltaCents: number;
  accepted: boolean;
  reason: string;
}

export interface QualityLoopMetrics {
  messagesAnalysed: number;
  conversationsAnalysed: number;
  qualityAverage: number;
  failedRate: number;
  rephraseRate: number;
  ackLatencyMs: number | null;
  finalLatencyMs: number | null;
  openProposals: number;
  approvedProposals: number;
  deployedProposals: number;
  rolledBackProposals: number;
  evaluatorCostCents: number;
}

export const HIGH_RISK_PROPOSAL_KEYS = [
  "auth",
  "permission",
  "permissions",
  "tenant",
  "isolation",
  "financial",
  "billing",
  "action_engine",
  "secret",
  "oauth",
  "write",
] as const;

export const AUTO_APPLY_KINDS: ProposalKind[] = [
  "prompt_tweak",
  "planner_config",
  "response_rule",
  "threshold",
  "ranking",
  "suggested_actions",
  "guidance_behaviour",
];
