export type IntelligenceChannel = "whatsapp" | "portal" | "api";

export type IntelligenceAction = "call_tool" | "answer" | "clarify";

export type IntelligenceConfidence = "strong" | "partial" | "none";

export type IntelligenceRoute = "FAST_LOCAL" | "INTELLIGENT" | "CONTROLLED_ACTION";

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
  | "missing_clarification";

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
