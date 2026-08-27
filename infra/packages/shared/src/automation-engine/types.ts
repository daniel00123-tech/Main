/**
 * INFRA Automation Engine V1 — shared contracts.
 */

export const AUTOMATION_STATUSES = [
  "draft",
  "active",
  "paused",
  "disabled",
  "error",
] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_TRIGGER_TYPES = [
  "schedule",
  "manual",
  "webhook",
  "connector_event",
  "data_change",
  "threshold",
  "email_received",
  "crm_event",
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const AUTOMATION_ACTION_TYPES = ["ai_prompt", "mcp_tool", "internal"] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const AUTOMATION_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AUTOMATION_SCHEDULE_FREQUENCIES = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
] as const;
export type AutomationScheduleFrequency = (typeof AUTOMATION_SCHEDULE_FREQUENCIES)[number];

export type AutomationSchedule = {
  frequency: AutomationScheduleFrequency;
  hour?: number;
  minute?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
};

export type AutomationAiPromptConfiguration = {
  prompt: string;
  context?: Record<string, unknown>;
};

export type AutomationMcpToolConfiguration = {
  toolName: string;
  arguments?: Record<string, unknown>;
};

export type AutomationInternalConfiguration = {
  handler: string;
  parameters?: Record<string, unknown>;
};

export type AutomationDefinitionRecord = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  triggerType: AutomationTriggerType;
  schedule: AutomationSchedule | null;
  timezone: string;
  actionType: AutomationActionType;
  configuration: Record<string, unknown>;
  serviceIdentityId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  failureCount: number;
  maximumRetries: number;
};

export type AutomationRunRecord = {
  id: string;
  companyId: string;
  automationId: string;
  status: AutomationRunStatus;
  triggerType: AutomationTriggerType;
  idempotencyKey: string | null;
  attempt: number;
  initiatedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRunStepRecord = {
  id: string;
  companyId: string;
  runId: string;
  stepIndex: number;
  actionType: AutomationActionType;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  startedAt: string | null;
  completedAt: string | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
