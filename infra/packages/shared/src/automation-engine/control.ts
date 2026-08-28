/**
 * Natural-language automation control V1 — typed specification and
 * allowlisted action catalogue. ChatGPT may propose a plan; INFRA
 * independently validates and persists configuration only.
 *
 * No executable customer-supplied JavaScript/Python is accepted.
 */

import {
  AUTOMATION_SCHEDULE_FREQUENCIES,
  type AutomationDefinitionRecord,
  type AutomationSchedule,
  type AutomationScheduleFrequency,
} from "./types";
import {
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
  automationRecipientEmailOf,
  automationTemplateKeyOf,
  getAutomationTemplate,
  isValidRecipientEmail,
} from "./templates";

export const AUTOMATION_CREATED_VIA = [
  "chatgpt",
  "portal",
  "platform_admin",
  "api",
] as const;
export type AutomationCreatedVia = (typeof AUTOMATION_CREATED_VIA)[number];

export const AUTOMATION_CONTROL_ACTIONS = [
  "XERO_MONTH_TO_DATE_SALES",
  "KNOWLEDGE_DOCUMENT_ACTIVITY",
  "SEND_TRANSACTIONAL_REPORT_EMAIL",
] as const;
export type AutomationControlAction = (typeof AUTOMATION_CONTROL_ACTIONS)[number];

/** Xero financial mutations — never allowed in the V1 NL builder. */
export const FORBIDDEN_AUTOMATION_ACTIONS = [
  "XERO_CREATE_INVOICE",
  "XERO_UPDATE_INVOICE",
  "XERO_APPROVE_INVOICE",
  "XERO_SEND_INVOICE",
  "XERO_VOID_INVOICE",
  "XERO_ALLOCATE_PAYMENT",
  "XERO_CREATE_BILL",
  "XERO_APPROVE_BILL",
  "XERO_CREATE_CREDIT_NOTE",
  "XERO_APPROVE_CREDIT_NOTE",
  "XERO_CREATE_CONTACT",
  "create_invoice",
  "update_invoice",
  "approve_invoice",
  "send_invoice",
  "void_invoice",
  "allocate_payment",
  "xero.create_invoice",
  "xero.update_invoice",
  "xero.approve_invoice",
  "xero.send_invoice",
  "xero.void_invoice",
  "xero.allocate_payment",
  "plan_xero_draft_invoice",
  "plan_xero_approve_invoice",
  "plan_xero_send_invoice",
  "plan_xero_void_document",
  "plan_xero_remittance_allocation",
  "plan_xero_credit_invoices",
  "plan_xero_draft_bill",
  "plan_xero_approve_bill",
  "plan_xero_create_contact",
  "plan_xero_create_approve_send",
  "execute_action_plan",
] as const;

const ACTION_ALIASES: Record<string, AutomationControlAction | "REPORT_SALES_SUMMARY"> = {
  XERO_MONTH_TO_DATE_SALES: "XERO_MONTH_TO_DATE_SALES",
  "xero.month_to_date_sales": "XERO_MONTH_TO_DATE_SALES",
  "xero.sales_summary": "XERO_MONTH_TO_DATE_SALES",
  KNOWLEDGE_DOCUMENT_ACTIVITY: "KNOWLEDGE_DOCUMENT_ACTIVITY",
  "knowledge.document_activity": "KNOWLEDGE_DOCUMENT_ACTIVITY",
  "knowledge.documents": "KNOWLEDGE_DOCUMENT_ACTIVITY",
  SEND_TRANSACTIONAL_REPORT_EMAIL: "SEND_TRANSACTIONAL_REPORT_EMAIL",
  "email.send_report": "SEND_TRANSACTIONAL_REPORT_EMAIL",
  "email.send": "SEND_TRANSACTIONAL_REPORT_EMAIL",
  "report.sales_summary": "REPORT_SALES_SUMMARY",
};

export const DOCUMENT_SOURCE_CONNECTOR_IDS = [
  "conn_google_drive",
  "conn_onedrive",
  "conn_sharepoint",
  "conn_microsoft_365",
  "conn_outlook_shared",
] as const;

export type AutomationControlTrigger = {
  type: "schedule";
  frequency: AutomationScheduleFrequency;
  time: string;
  timezone: string;
};

export type AutomationControlStep = {
  type: string;
};

export type AutomationControlSpec = {
  companyId: string;
  name?: string;
  trigger: AutomationControlTrigger;
  timezone?: string;
  steps?: AutomationControlStep[];
  recipients?: string[];
  recipientEmail?: string;
  enabled?: boolean;
  templateKey?: string;
  allowDuplicate?: boolean;
};

export type AutomationControlValidationIssue = {
  code: string;
  message: string;
};

export type ResolvedAutomationTemplate = {
  templateKey: string;
  emailType: "XERO_SALES_REPORT" | "DOCUMENT_ACTIVITY_REPORT";
  defaultName: string;
  label: string;
  requiresXero: boolean;
  requiresDocuments: boolean;
};

export type AutomationCapabilitySnapshot = {
  xeroConnected: boolean;
  documentSourcesConnected: boolean;
  emailEnabled: boolean;
  allowedEmailTypes: string[];
  senderAddress: string | null;
};

export type AutomationDuplicateMatch = {
  id: string;
  name: string;
  status: string;
  scheduleLabel: string;
  recipientEmail: string | null;
};

export function normaliseActionType(raw: string): string {
  return raw.trim();
}

export function isForbiddenAutomationAction(type: string): boolean {
  const value = normaliseActionType(type);
  if ((FORBIDDEN_AUTOMATION_ACTIONS as readonly string[]).includes(value)) {
    return true;
  }
  const lower = value.toLowerCase();
  return (
    /xero\.(create|update|approve|send|void|allocate|delete)/i.test(value) ||
    /plan_xero_/.test(lower) ||
    /execute_action_plan/.test(lower) ||
    /\b(create|update|approve|send|void)\s+invoice\b/i.test(value) ||
    /\ballocate\s+payment\b/i.test(value)
  );
}

export function resolveCatalogueAction(
  type: string,
): AutomationControlAction | "REPORT_SALES_SUMMARY" | null {
  const value = normaliseActionType(type);
  if (ACTION_ALIASES[value]) return ACTION_ALIASES[value];
  const upper = value.toUpperCase().replace(/[.\s-]+/g, "_");
  if ((AUTOMATION_CONTROL_ACTIONS as readonly string[]).includes(upper)) {
    return upper as AutomationControlAction;
  }
  return null;
}

export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function formatClockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  const value = timeZone.trim();
  if (!value || value.length > 64) return false;
  try {
    Intl.DateTimeFormat("en-GB", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTemplateFromSpec(
  spec: Pick<AutomationControlSpec, "steps" | "templateKey">,
): { ok: true; resolved: ResolvedAutomationTemplate } | { ok: false; issue: AutomationControlValidationIssue } {
  if (spec.templateKey) {
    const template = getAutomationTemplate(spec.templateKey);
    if (!template || !template.available) {
      return {
        ok: false,
        issue: {
          code: "UNKNOWN_TEMPLATE",
          message: "Unknown or unavailable automation template.",
        },
      };
    }
    return { ok: true, resolved: resolvedFromTemplateKey(template.key) };
  }

  const steps = spec.steps ?? [];
  if (steps.length === 0) {
    return {
      ok: false,
      issue: {
        code: "STEPS_REQUIRED",
        message: "Provide approved action steps or a supported template.",
      },
    };
  }

  for (const step of steps) {
    if (isForbiddenAutomationAction(step.type)) {
      return {
        ok: false,
        issue: {
          code: "XERO_WRITE_FORBIDDEN",
          message:
            "This automation builder cannot include Xero financial writes such as creating, updating, approving, sending, voiding invoices or allocating payments.",
        },
      };
    }
  }

  const resolved = steps.map((step) => resolveCatalogueAction(step.type));
  if (resolved.some((item) => item === null)) {
    const unknown = steps.find((_, index) => resolved[index] === null);
    return {
      ok: false,
      issue: {
        code: "UNKNOWN_ACTION",
        message: `Action '${unknown?.type ?? "unknown"}' is not in the approved automation catalogue.`,
      },
    };
  }

  const hasSales = resolved.includes("XERO_MONTH_TO_DATE_SALES");
  const hasDocuments = resolved.includes("KNOWLEDGE_DOCUMENT_ACTIVITY");
  const hasEmail = resolved.includes("SEND_TRANSACTIONAL_REPORT_EMAIL");

  if (hasSales && hasDocuments) {
    return {
      ok: false,
      issue: {
        code: "INCOMPATIBLE_ACTIONS",
        message: "Sales and document activity cannot be combined in a single V1 automation.",
      },
    };
  }
  if (!hasEmail) {
    return {
      ok: false,
      issue: {
        code: "EMAIL_STEP_REQUIRED",
        message: "V1 automations must include SEND_TRANSACTIONAL_REPORT_EMAIL.",
      },
    };
  }
  if (hasSales) {
    return { ok: true, resolved: resolvedFromTemplateKey(XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE) };
  }
  if (hasDocuments) {
    return { ok: true, resolved: resolvedFromTemplateKey(DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE) };
  }
  return {
    ok: false,
    issue: {
      code: "DATA_STEP_REQUIRED",
      message: "Include XERO_MONTH_TO_DATE_SALES or KNOWLEDGE_DOCUMENT_ACTIVITY.",
    },
  };
}

function resolvedFromTemplateKey(templateKey: string): ResolvedAutomationTemplate {
  const template = getAutomationTemplate(templateKey);
  const isSales = templateKey === XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE;
  return {
    templateKey,
    emailType: isSales ? "XERO_SALES_REPORT" : "DOCUMENT_ACTIVITY_REPORT",
    defaultName: template?.defaultName ?? templateKey,
    label: template?.label ?? templateKey,
    requiresXero: isSales,
    requiresDocuments: !isSales,
  };
}

export function specRecipient(spec: AutomationControlSpec): string | null {
  const fromList = spec.recipients?.find((item) => typeof item === "string" && item.trim());
  const raw = (fromList ?? spec.recipientEmail ?? "").trim().toLowerCase();
  return raw || null;
}

export function specToSchedule(spec: AutomationControlSpec): AutomationSchedule | null {
  if (spec.trigger?.type !== "schedule") return null;
  if (!AUTOMATION_SCHEDULE_FREQUENCIES.includes(spec.trigger.frequency)) return null;
  const clock = parseClockTime(spec.trigger.time);
  if (!clock) return null;
  return {
    frequency: spec.trigger.frequency,
    hour: clock.hour,
    minute: clock.minute,
  };
}

export function automationCreatedViaOf(
  configuration: Record<string, unknown> | null | undefined,
): AutomationCreatedVia | null {
  if (!configuration) return null;
  const value = configuration.createdVia;
  if (typeof value === "string" && (AUTOMATION_CREATED_VIA as readonly string[]).includes(value)) {
    return value as AutomationCreatedVia;
  }
  return null;
}

export function isArchivedAutomation(
  automation: Pick<AutomationDefinitionRecord, "status" | "configuration">,
): boolean {
  return automation.configuration?.archived === true;
}

export function materialAutomationFingerprint(input: {
  templateKey: string;
  frequency: string;
  hour: number;
  minute: number;
  timezone: string;
  recipientEmail: string;
}): string {
  return [
    input.templateKey,
    input.frequency,
    String(input.hour),
    String(input.minute),
    input.timezone.trim(),
    input.recipientEmail.trim().toLowerCase(),
  ].join("|");
}

export function fingerprintForAutomation(
  automation: Pick<AutomationDefinitionRecord, "schedule" | "timezone" | "configuration">,
): string | null {
  const templateKey = automationTemplateKeyOf(automation.configuration);
  const recipient = automationRecipientEmailOf(automation.configuration);
  if (!templateKey || !recipient || !automation.schedule) return null;
  return materialAutomationFingerprint({
    templateKey,
    frequency: automation.schedule.frequency,
    hour: automation.schedule.hour ?? 0,
    minute: automation.schedule.minute ?? 0,
    timezone: automation.timezone,
    recipientEmail: recipient,
  });
}

export function validateAutomationControlSpec(
  spec: AutomationControlSpec,
  capabilities: AutomationCapabilitySnapshot,
): {
  ok: boolean;
  issues: AutomationControlValidationIssue[];
  resolved: ResolvedAutomationTemplate | null;
  schedule: AutomationSchedule | null;
  timezone: string | null;
  recipientEmail: string | null;
  name: string | null;
} {
  const issues: AutomationControlValidationIssue[] = [];
  if (!spec.companyId?.trim()) {
    issues.push({ code: "COMPANY_REQUIRED", message: "Company is required." });
  }

  const template = resolveTemplateFromSpec(spec);
  if (!template.ok) issues.push(template.issue);
  const resolved = template.ok ? template.resolved : null;

  const timezone = (spec.trigger?.timezone || spec.timezone || "").trim();
  if (!timezone) {
    issues.push({ code: "TIMEZONE_REQUIRED", message: "An IANA timezone is required, for example Europe/London." });
  } else if (!isValidIanaTimeZone(timezone)) {
    issues.push({
      code: "INVALID_TIMEZONE",
      message: `'${timezone}' is not a valid IANA timezone. Use Europe/London for UK companies.`,
    });
  }

  if (!spec.trigger || spec.trigger.type !== "schedule") {
    issues.push({
      code: "INVALID_TRIGGER",
      message: "V1 automations require a schedule trigger (daily, weekdays, weekly, or monthly).",
    });
  } else if (!AUTOMATION_SCHEDULE_FREQUENCIES.includes(spec.trigger.frequency)) {
    issues.push({
      code: "INVALID_SCHEDULE",
      message: "Frequency must be daily, weekdays, weekly, or monthly.",
    });
  }

  const clock = spec.trigger?.time ? parseClockTime(spec.trigger.time) : null;
  if (!clock) {
    issues.push({
      code: "INVALID_SCHEDULE",
      message: "Time must be HH:MM in 24-hour format, for example 08:00.",
    });
  }

  const recipient = specRecipient(spec);
  if (!recipient || !isValidRecipientEmail(recipient)) {
    issues.push({
      code: "INVALID_RECIPIENT",
      message: "A valid recipient email is required.",
    });
  }

  if (resolved?.requiresXero && !capabilities.xeroConnected) {
    issues.push({
      code: "XERO_NOT_CONNECTED",
      message: "Xero isn't connected for this company.",
    });
  }
  if (resolved?.requiresDocuments && !capabilities.documentSourcesConnected) {
    issues.push({
      code: "DOCUMENTS_NOT_CONNECTED",
      message: "No document sources are connected for this company.",
    });
  }
  if (!capabilities.emailEnabled || !capabilities.senderAddress) {
    issues.push({
      code: "EMAIL_NOT_CONFIGURED",
      message: "Outbound email isn't configured for this company.",
    });
  } else if (resolved && !capabilities.allowedEmailTypes.includes(resolved.emailType)) {
    issues.push({
      code: "EMAIL_TYPE_NOT_ALLOWED",
      message: `Email type ${resolved.emailType} is not enabled for this company.`,
    });
  }

  const schedule = specToSchedule(spec);
  const name = (spec.name?.trim() || resolved?.defaultName || "").slice(0, 200) || null;

  return {
    ok: issues.length === 0,
    issues,
    resolved,
    schedule,
    timezone: timezone || null,
    recipientEmail: recipient,
    name,
  };
}

export function describeAutomationPlan(input: {
  name: string;
  timezone: string;
  schedule: AutomationSchedule;
  recipientEmail: string;
  resolved: ResolvedAutomationTemplate;
  senderAddress?: string | null;
  companyName?: string | null;
}): {
  name: string;
  schedule: string;
  timezone: string;
  data: string;
  report: string;
  recipient: string;
  sender: string | null;
  actions: string[];
} {
  const time = formatClockTime(input.schedule.hour ?? 0, input.schedule.minute ?? 0);
  const every =
    input.schedule.frequency === "weekdays"
      ? "Every weekday"
      : input.schedule.frequency === "weekly"
        ? "Every week"
        : input.schedule.frequency === "monthly"
          ? "Every month"
          : "Every day";
  const data = input.resolved.requiresXero
    ? input.companyName
      ? `${input.companyName} Xero`
      : "Company Xero"
    : "Company Knowledge metadata";
  const actions = input.resolved.requiresXero
    ? ["Read Xero sales summary", "Format report", "Send email"]
    : [
        "Read company document metadata",
        "Count unique documents by source",
        "Identify new or updated documents from the previous 24 hours",
        "Format report",
        "Send email",
      ];
  return {
    name: input.name,
    schedule: `${every} at ${time}`,
    timezone: input.timezone,
    data,
    report: input.resolved.requiresXero ? "Month-to-date sales" : "Document activity (last 24 hours)",
    recipient: input.recipientEmail,
    sender: input.senderAddress ?? null,
    actions,
  };
}

export function createdViaLabel(value: AutomationCreatedVia | null | undefined): string {
  switch (value) {
    case "chatgpt":
      return "ChatGPT";
    case "portal":
      return "Company Portal";
    case "platform_admin":
      return "Platform admin";
    case "api":
      return "API";
    default:
      return "INFRA";
  }
}
