export const TARGETED_SUITE_ID = "el-targeted-quality-v1" as const;
export const TARGETED_COMPANY_ID = "co_el" as const;

export type TargetedFamily =
  | "knowledge"
  | "outlook"
  | "mixed"
  | "followup"
  | "correction"
  | "portal"
  | "telemetry";

export type TargetedQuestion = {
  id: string;
  channel: "portal" | "whatsapp" | "followup";
  text: string;
  actor: "director" | "office_staff";
  family: TargetedFamily;
  expectedToolPrefix: string | null;
  expectedSource: "knowledge" | "outlook" | "catalogue" | "xero_live" | "xero_warehouse" | "none" | null;
  expectedDeny: boolean;
  sequence?: string;
  sequenceIndex?: number;
  honestNoResultOk?: boolean;
  subjectOnly?: boolean;
};
