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
  recentTurns: Array<{ role: "user" | "assistant"; text: string }>;
  lastUserText: string;
  lastToolName?: string | null;
  lastToolSummary?: string | null;
  userCorrection?: boolean;
};

export type IntelligenceModelUsage = {
  provider: "workers-ai" | "openai" | "none";
  model: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
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
