export type IntelligenceChannel = "whatsapp" | "portal" | "api";

export type IntelligenceAction = "call_tool" | "answer" | "clarify";

export type IntelligenceConfidence = "strong" | "partial" | "none";

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
  entities: Array<{
    type: string;
    id: string;
    title: string;
    url?: string | null;
  }>;
  currentDocument: IntelligenceDocumentRef | null;
  recentTurns: Array<{ role: "user" | "assistant"; text: string }>;
  lastUserText: string;
};

export type IntelligenceModelUsage = {
  provider: "workers-ai" | "openai" | "none";
  model: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
};

export type IntelligenceTurnResult = {
  kind: "answer" | "clarify" | "fast_path" | "failed";
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
};

export type IntelligenceToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, string>;
};

export type IntelligenceRuntime = {
  executeTool(call: IntelligenceToolCall): Promise<IntelligenceToolResult>;
};

export type IntelligenceEnv = {
  AI?: { run: (model: string, inputs: Record<string, unknown>) => Promise<unknown> };
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  WHATSAPP_GROUNDED_MODEL?: string;
};
