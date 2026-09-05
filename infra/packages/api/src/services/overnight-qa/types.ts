export const OVERNIGHT_SUITE_ID = "el-overnight-qa-v1" as const;
export const OVERNIGHT_COMPANY_ID = "co_el" as const;

export type OvernightChannel = "whatsapp" | "portal" | "mcp" | "warehouse" | "followup";
export type OvernightActor = "director" | "office_staff";
export type OvernightFamily =
  | "xero_live"
  | "xero_warehouse"
  | "outlook"
  | "knowledge"
  | "catalogue"
  | "mixed"
  | "followup"
  | "correction"
  | "rbac"
  | "no_tool"
  | "routing";

export type ExpectedSource = "xero_warehouse" | "xero_live" | "outlook" | "knowledge" | "catalogue" | "web" | "none" | null;

export type OvernightQuestion = {
  id: string;
  channel: OvernightChannel;
  text: string;
  actor: OvernightActor;
  family: OvernightFamily;
  expectedToolPrefix: string | null;
  expectedSource: ExpectedSource;
  expectedDeny: boolean;
  sequence?: string;
  sequenceIndex?: number;
  mcpTool?: string;
  mcpArgs?: Record<string, unknown>;
  notes?: string;
};

export type OvernightTurnScore = {
  id: string;
  channel: OvernightChannel;
  text: string;
  actor: OvernightActor;
  family: OvernightFamily;
  tools: string[];
  expectedSource: ExpectedSource;
  actualSource: string | null;
  sourceOk: boolean;
  rbacOk: boolean;
  grounded: boolean;
  firstAnswer: boolean;
  hallucination: boolean;
  unnecessaryTools: boolean;
  duplicateTools: boolean;
  genericRetry: boolean;
  charged: boolean;
  latencyMs: number;
  reply: string;
  terminal: string;
  perfect: boolean;
  defects: string[];
};

export type ChannelScore = {
  channel: string;
  turns: number;
  perfect: number;
  score: number;
  defects: string[];
};
