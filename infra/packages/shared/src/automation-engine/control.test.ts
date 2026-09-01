import { describe, expect, it } from "vitest";
import {
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
} from "./templates";
import {
  describeAutomationPlan,
  isForbiddenAutomationAction,
  isValidIanaTimeZone,
  materialAutomationFingerprint,
  parseClockTime,
  resolveTemplateFromSpec,
  validateAutomationControlSpec,
  type AutomationCapabilitySnapshot,
} from "./control";

const capable: AutomationCapabilitySnapshot = {
  xeroConnected: true,
  documentSourcesConnected: true,
  emailEnabled: true,
  allowedEmailTypes: ["XERO_SALES_REPORT", "DOCUMENT_ACTIVITY_REPORT"],
  senderAddress: "noreply@infrastack.app",
};

describe("automation action catalogue", () => {
  it("maps allowlisted steps to the sales email template", () => {
    const resolved = resolveTemplateFromSpec({
      steps: [
        { type: "xero.month_to_date_sales" },
        { type: "report.sales_summary" },
        { type: "email.send_report" },
      ],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.templateKey).toBe(XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE);
    }
  });

  it("maps document activity steps to the document email template", () => {
    const resolved = resolveTemplateFromSpec({
      steps: [
        { type: "KNOWLEDGE_DOCUMENT_ACTIVITY" },
        { type: "SEND_TRANSACTIONAL_REPORT_EMAIL" },
      ],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resolved.templateKey).toBe(DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE);
    }
  });

  it("rejects Xero write actions", () => {
    expect(isForbiddenAutomationAction("XERO_CREATE_INVOICE")).toBe(true);
    expect(isForbiddenAutomationAction("plan_xero_draft_invoice")).toBe(true);
    expect(isForbiddenAutomationAction("allocate payment")).toBe(true);
    expect(isForbiddenAutomationAction("XERO_MONTH_TO_DATE_SALES")).toBe(false);
    const resolved = resolveTemplateFromSpec({
      steps: [
        { type: "plan_xero_approve_invoice" },
        { type: "SEND_TRANSACTIONAL_REPORT_EMAIL" },
      ],
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.issue.code).toBe("XERO_WRITE_FORBIDDEN");
  });

  it("rejects unknown actions", () => {
    const resolved = resolveTemplateFromSpec({
      steps: [{ type: "run_arbitrary_python" }, { type: "SEND_TRANSACTIONAL_REPORT_EMAIL" }],
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.issue.code).toBe("UNKNOWN_ACTION");
  });
});

describe("automation plan validation", () => {
  it("accepts a valid sales plan", () => {
    const result = validateAutomationControlSpec(
      {
        companyId: "co_a",
        name: "Daily month-to-date sales",
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "08:00",
          timezone: "Europe/London",
        },
        steps: [
          { type: "XERO_MONTH_TO_DATE_SALES" },
          { type: "SEND_TRANSACTIONAL_REPORT_EMAIL" },
        ],
        recipientEmail: "daniel@example.com",
      },
      capable,
    );
    expect(result.ok).toBe(true);
    expect(result.schedule).toEqual({ frequency: "daily", hour: 8, minute: 0 });
  });

  it("rejects invalid timezone and recipient", () => {
    const result = validateAutomationControlSpec(
      {
        companyId: "co_a",
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "08:00",
          timezone: "Not/AZone",
        },
        templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        recipientEmail: "not-an-email",
      },
      capable,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["INVALID_TIMEZONE", "INVALID_RECIPIENT"]),
    );
  });

  it("rejects missing Xero connector", () => {
    const result = validateAutomationControlSpec(
      {
        companyId: "co_a",
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "08:00",
          timezone: "Europe/London",
        },
        templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        recipientEmail: "ops@example.com",
      },
      { ...capable, xeroConnected: false },
    );
    expect(result.issues.some((item) => item.code === "XERO_NOT_CONNECTED")).toBe(true);
    expect(result.issues.find((item) => item.code === "XERO_NOT_CONNECTED")?.message).toMatch(
      /Xero isn't connected/i,
    );
  });

  it("rejects missing email capability", () => {
    const result = validateAutomationControlSpec(
      {
        companyId: "co_a",
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "12:00",
          timezone: "Europe/London",
        },
        templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
        recipientEmail: "ops@example.com",
      },
      { ...capable, emailEnabled: false, senderAddress: null },
    );
    expect(result.issues.some((item) => item.code === "EMAIL_NOT_CONFIGURED")).toBe(true);
  });

  it("parses clock times and IANA zones", () => {
    expect(parseClockTime("7:30")).toEqual({ hour: 7, minute: 30 });
    expect(parseClockTime("25:00")).toBeNull();
    expect(isValidIanaTimeZone("Europe/London")).toBe(true);
    expect(isValidIanaTimeZone("UTC")).toBe(true);
    expect(isValidIanaTimeZone("Europe/Londn")).toBe(false);
  });

  it("detects materially identical automations via fingerprint", () => {
    const a = materialAutomationFingerprint({
      templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      frequency: "daily",
      hour: 8,
      minute: 0,
      timezone: "Europe/London",
      recipientEmail: "Daniel@Example.com",
    });
    const b = materialAutomationFingerprint({
      templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      frequency: "daily",
      hour: 8,
      minute: 0,
      timezone: "Europe/London",
      recipientEmail: "daniel@example.com",
    });
    const c = materialAutomationFingerprint({
      templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      frequency: "daily",
      hour: 7,
      minute: 30,
      timezone: "Europe/London",
      recipientEmail: "daniel@example.com",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("describes a customer-facing plan without cron", () => {
    const summary = describeAutomationPlan({
      name: "Daily month-to-date sales",
      timezone: "Europe/London",
      schedule: { frequency: "daily", hour: 8, minute: 0 },
      recipientEmail: "daniel@example.com",
      resolved: {
        templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        emailType: "XERO_SALES_REPORT",
        defaultName: "Daily month-to-date sales",
        label: "Daily sales email",
        requiresXero: true,
        requiresDocuments: false,
      },
      senderAddress: "noreply@infrastack.app",
      companyName: "Caddington Holdings",
    });
    expect(summary.schedule).toBe("Every day at 08:00");
    expect(JSON.stringify(summary)).not.toMatch(/RRULE|BYHOUR|cron/i);
  });
});
