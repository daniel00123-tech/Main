export type IntelligenceChannel = "whatsapp" | "portal" | "api";

export type IntelligenceAction = "call_tool" | "answer" | "clarify";

export type IntelligenceConfidence = "strong" | "partial" | "none";

export type IntelligenceRoute = "FAST_LOCAL" | "INTELLIGENT" | "CONTROLLED_ACTION";

export type IntelligenceScope =
  | "GENERAL_CONVERSATION"
  | "CURRENT_DOCUMENT"
  | "RECENT_ENTITY"
  | "COMPANY_KNOWLEDGE"
  | "SYSTEM_META"
  | "CONNECTOR_CAPABILITY"
  | "BUSINESS_SYSTEM"
  | "CONTROLLED_ACTION"
  | "AMBIGUOUS";

export type BrainMode = "cloudflare" | "openai_shadow" | "openai_canary" | "openai_primary";

export type EvidenceNeed = "NEEDS_FRESH_DATA" | "CAN_ANSWER_FROM_EXISTING_EVIDENCE";

export type ResponseTerminal =
  | "ANSWER"
  | "PERMISSION_DENIED"
  | "NO_RESULTS"
  | "UPSTREAM_FAILURE"
  | "CLARIFICATION_REQUIRED";

export type ResponseGuardCheck = {
  id:
    | "tool_success_not_reported_as_failure"
    | "data_exists_not_no_result"
    | "not_wrong_system_email_to_xero"
    | "not_wrong_system_xero_to_knowledge"
    | "successful_result_not_discarded"
    | "not_generic_retry_after_success"
    | "not_blank"
    | "permission_uses_access_outcome"
    | "live_claim_has_evidence"
    | "xero_mentions_figures"
    | "not_permission_from_payload_words"
    | "not_contradictory_blank";
  ok: boolean;
};

export type RecentEmailEvidence = {
  id: string;
  subject: string;
  from: string;
  receivedDateTime: string;
  mailboxAddress: string;
  body: string;
  toolName: string;
};

export type RecentXeroEvidence = {
  toolName: string;
  total: number | null;
  count: number | null;
  fromDate: string | null;
  toDate: string | null;
  currency: string;
  summary: string;
  label: string;
};

export type RecentDocumentEvidence = {
  id: string;
  title: string;
  url?: string | null;
  excerpt: string;
  source?: string | null;
};

export type RecentCatalogueEvidence = {
  id: string;
  title: string;
  source?: string | null;
};

export type StructuredEvidence = {
  recentEmail?: RecentEmailEvidence | null;
  recentXero?: RecentXeroEvidence | null;
  recentDocument?: RecentDocumentEvidence | null;
  recentCatalogueItem?: RecentCatalogueEvidence | null;
  lastSuccessfulCalls?: Array<{ name: string; argsHash: string; summary: string }>;
};

export type IntelligenceQualityFlag =
  | "malformed_model_response"
  | "fallback"
  | "wrong_tool"
  | "user_correction"
  | "unsupported_answer"
  | "irrelevant_result"
  | "repeated_answer"
  | "lost_context"
  | "unnecessary_company_wide_search"
  | "bad_clarification"
  | "missing_clarification"
  | "system_question_as_current_doc"
  | "general_conversation_used_tool"
  | "scope_switch_ignored"
  | "correction_ignored"
  | "connector_hallucinated"
  | "count_invented"
  | "unnecessary_search_after_rephrase"
  | "ambiguous_answered_without_clarify"
  | "current_doc_retained_after_switch";

export type IntelligenceToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type IntelligenceToolResult = {
  name: string;
  ok: boolean;
  latencyMs: number;
  data: unknown;
  error?: string;
};

export type IntelligenceDocumentRef = {
  id: string;
  title: string;
  url?: string | null;
  source?: string | null;
  modifiedAt?: string | null;
  createdAt?: string | null;
  modifiedBy?: string | null;
};

export type IntelligenceConversationState = {
  companyId?: string | null;
  companyName?: string | null;
  role?: string | null;
  connectors: string[];
  permittedTools: string[];
  entities: Array<{
    type: string;
    id: string;
    title: string;
    url?: string | null;
  }>;
  currentDocument: IntelligenceDocumentRef | null;
  recentDocuments: IntelligenceDocumentRef[];
  currentScope?: IntelligenceScope | null;
  currentBusinessSystem?: string | null;
  lastSuccessfulTool?: string | null;
  lastAnswerTopic?: string | null;
  lastUserIntent?: string | null;
  lastAnswerText?: string | null;
  recentEvidence?: StructuredEvidence | null;
  recentTurns: Array<{ role: "user" | "assistant"; text: string }>;
  lastUserText: string;
  lastToolName?: string | null;
  lastToolSummary?: string | null;
  userCorrection?: boolean;
};

export type ShadowEvalRecord = {
  provider: "openai";
  model: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  estimatedCostUsd: number | null;
  costBasis: "estimated" | "unknown";
  correlationId: string | null;
  toolProposal: string[];
  failure: string | null;
  reusedEvidence: boolean;
  executedLiveTools: false;
  userVisibleProvider: "cloudflare";
};

export type IntelligenceModelUsage = {
  provider: "workers-ai" | "openai" | "none";
  model: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens?: number | null;
  estimatedCostUsd: number | null;
  costBasis?: "estimated" | "unknown";
  correlationId?: string | null;
  fallbackUsed?: boolean;
  malformed?: boolean;
};

export type IntelligenceTurnResult = {
  kind: "answer" | "clarify" | "fast_path" | "failed" | "controlled_action";
  text: string;
  confidence: IntelligenceConfidence;
  offerSearchOther: boolean;
  toolCalls: IntelligenceToolResult[];
  currentDocument: IntelligenceDocumentRef | null;
  evidenceDocumentIds: string[];
  clarification: boolean;
  citeSource: boolean;
  modelRounds: IntelligenceModelUsage[];
  totalModelMs: number;
  totalToolMs: number;
  provider: IntelligenceModelUsage["provider"];
  model: string | null;
  estimatedCostUsd: number;
  route?: IntelligenceRoute;
  scope?: IntelligenceScope;
  lastAnswerTopic?: string | null;
  lastUserIntent?: string | null;
  qualityFlags?: IntelligenceQualityFlag[];
  repaired?: boolean;
  fallbackUsed?: boolean;
  recentEvidence?: StructuredEvidence | null;
  terminal?: ResponseTerminal;
  brainMode?: BrainMode;
  correlationId?: string | null;
  guardChecks?: ResponseGuardCheck[];
  /** Parallel OpenAI evaluation. Never shown to the customer. */
  shadowEval?: ShadowEvalRecord | null;
};

export type IntelligenceToolParam = {
  type?: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
};

export type IntelligenceToolSpec = {
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string;
  parameters: Record<string, IntelligenceToolParam>;
  outputShape: string;
  permission: string;
};

export type IntelligenceRuntime = {
  executeTool(call: IntelligenceToolCall): Promise<IntelligenceToolResult>;
};

export type IntelligenceEnv = {
  AI?: { run: (model: string, inputs: Record<string, unknown>) => Promise<unknown> };
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_BRAIN_ENABLED?: string;
  OPENAI_BRAIN_MODE?: string;
  OPENAI_BRAIN_COMPANY_IDS?: string;
  OPENAI_BRAIN_CANARY_PERCENT?: string;
  OPENAI_MODEL_FAST?: string;
  OPENAI_MODEL_DEFAULT?: string;
  OPENAI_MODEL_REASONING?: string;
  WHATSAPP_GROUNDED_MODEL?: string;
  INTELLIGENCE_FALLBACK_MODEL?: string;
  INTELLIGENCE_ESCALATE_MODEL?: string;
  INTELLIGENCE_SHADOW_EVAL?: string;
};

export type IntelligenceDecision =
  | { action: "call_tool"; name: string; arguments: Record<string, unknown> }
  | {
      action: "answer";
      text: string;
      confidence: IntelligenceConfidence;
      offer_search_other: boolean;
      cite_source: boolean;
    }
  | { action: "clarify"; text: string }
  | { action: "invalid"; reason: string };
