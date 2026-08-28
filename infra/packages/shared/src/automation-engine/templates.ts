/**
 * Customer-facing automation templates. Tenant-agnostic — no company IDs.
 * V1 ships one approved action; additional templates may appear later as coming soon.
 */

import type { AutomationActionType, AutomationSchedule } from "./types";

export const XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE =
  "xero_month_to_date_sales_email" as const;
export const DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE =
  "document_activity_daily_email" as const;

export type AutomationTemplateKey =
  | typeof XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE
  | typeof DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE;

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
