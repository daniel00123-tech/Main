/**
 * Customer-facing automation templates. Tenant-agnostic — no company IDs.
 * V1 ships one approved action; additional templates may appear later as coming soon.
 */

import type { AutomationActionType, AutomationSchedule } from "./types";

export const XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE =
  "xero_month_to_date_sales_email" as const;
export const DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE =
  "document_activity_daily_email" as const;
export const KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE =
  "knowledge_ingestion_daily_email" as const;
export const DAILY_IMPROVEMENT_QA_TEMPLATE = "daily_improvement_qa" as const;
export const DAILY_IMPROVEMENT_REPORT_TEMPLATE = "daily_improvement_report" as const;
export const DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE = "daily_improvement_engineering" as const;

export type AutomationTemplateKey =
  | typeof XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE
  | typeof DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE
  | typeof KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE
  | typeof DAILY_IMPROVEMENT_QA_TEMPLATE
  | typeof DAILY_IMPROVEMENT_REPORT_TEMPLATE
  | typeof DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE;

export type AutomationTemplateDefinition = {
  key: string;
  type: string;
  label: string;
  description: string;
  system: string;
  defaultName: string;
  defaultSchedule: AutomationSchedule;
  defaultTimezone: string;
  actionType: AutomationActionType;
  available: boolean;
};

export const AUTOMATION_TEMPLATES: AutomationTemplateDefinition[] = [
  {
    key: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
    type: "XERO_MONTH_TO_DATE_SALES_EMAIL",
    label: "Daily sales email",
    description: "Receive your current month's Xero sales by email every morning.",
    system: "Xero",
    defaultName: "Daily month-to-date sales",
    defaultSchedule: { frequency: "daily", hour: 8, minute: 0 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: true,
  },
  {
    key: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
    type: "DOCUMENT_ACTIVITY_DAILY_EMAIL",
    label: "Daily document activity",
    description:
      "Receive a daily summary of your connected company documents and any new or updated documents from the previous 24 hours.",
    system: "Documents",
    defaultName: "Daily document activity",
    defaultSchedule: { frequency: "daily", hour: 12, minute: 0 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: true,
  },
  {
    key: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
    type: "KNOWLEDGE_INGESTION_DAILY_EMAIL",
    label: "Daily knowledge activity",
    description:
      "Receive a simple daily email of what INFRA found and successfully synchronised from Microsoft 365 and company knowledge.",
    system: "Knowledge",
    defaultName: "Daily knowledge activity",
    defaultSchedule: { frequency: "daily", hour: 8, minute: 0 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: true,
  },
  {
    key: DAILY_IMPROVEMENT_QA_TEMPLATE,
    type: "DAILY_IMPROVEMENT_QA",
    label: "Daily AI quality window",
    description:
      "Platform-wide QA over genuine customer interactions since the previous completed window. Not a customer template.",
    system: "Quality",
    defaultName: "INFRA Daily improvement QA",
    defaultSchedule: { frequency: "daily", hour: 16, minute: 30 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: false,
  },
  {
    key: DAILY_IMPROVEMENT_REPORT_TEMPLATE,
    type: "DAILY_IMPROVEMENT_REPORT",
    label: "Daily AI quality report",
    description:
      "Sends the 17:00 Europe/London INFRA Daily Improvement Report. Informational only — no approval required.",
    system: "Quality",
    defaultName: "INFRA Daily improvement report",
    defaultSchedule: { frequency: "daily", hour: 17, minute: 0 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: false,
  },
  {
    key: DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
    type: "DAILY_IMPROVEMENT_ENGINEERING",
    label: "Daily automatic engineering",
    description:
      "Starts the asynchronous Cursor/dev engineering cycle. Does not run on the customer path.",
    system: "Quality",
    defaultName: "INFRA Daily improvement engineering",
    defaultSchedule: { frequency: "daily", hour: 17, minute: 5 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: false,
  },
  {
    key: "weekly_outstanding_invoices",
    type: "WEEKLY_OUTSTANDING_INVOICES",
    label: "Weekly outstanding invoices",
    description: "Coming soon.",
    system: "Xero",
    defaultName: "Weekly outstanding invoices",
    defaultSchedule: { frequency: "weekly", hour: 8, minute: 0, dayOfWeek: 1 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: false,
  },
  {
    key: "monthly_pnl_report",
    type: "MONTHLY_PNL_REPORT",
    label: "Monthly P&L report",
    description: "Coming soon.",
    system: "Xero",
    defaultName: "Monthly P&L report",
    defaultSchedule: { frequency: "monthly", hour: 8, minute: 0, dayOfMonth: 1 },
    defaultTimezone: "Europe/London",
    actionType: "internal",
    available: false,
  },
];

export function getAutomationTemplate(key: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES.find((item) => item.key === key) ?? null;
}

export function listAvailableAutomationTemplates(): AutomationTemplateDefinition[] {
  return AUTOMATION_TEMPLATES.filter((item) => item.available);
}

export function isValidRecipientEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function automationTemplateKeyOf(
  configuration: Record<string, unknown> | null | undefined,
): string | null {
  if (!configuration) return null;
  if (typeof configuration.templateKey === "string" && configuration.templateKey) {
    return configuration.templateKey;
  }
  if (typeof configuration.handler === "string" && getAutomationTemplate(configuration.handler)) {
    return configuration.handler;
  }
  return null;
}

export function automationRecipientEmailOf(
  configuration: Record<string, unknown> | null | undefined,
): string | null {
  if (!configuration) return null;
  const params = (configuration.parameters ?? {}) as Record<string, unknown>;
  const value = params.recipientEmail ?? configuration.recipientEmail;
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}
