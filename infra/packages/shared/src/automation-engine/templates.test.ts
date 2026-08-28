import { describe, expect, it } from "vitest";
import { monthToDateRangeInTimeZone, formatCivilDateLong, formatMajorCurrency } from "./month-to-date";
import {
  AUTOMATION_TEMPLATES,
  getAutomationTemplate,
  isValidRecipientEmail,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
} from "./templates";

describe("automation templates", () => {
  it("exposes a reusable Xero sales email template without a tenant id", () => {
    const template = getAutomationTemplate(XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE);
    expect(template?.type).toBe("XERO_MONTH_TO_DATE_SALES_EMAIL");
    expect(template?.available).toBe(true);
    expect(JSON.stringify(AUTOMATION_TEMPLATES)).not.toMatch(/co_caddington|ht-business|elvex/i);
  });

  it("validates recipient emails", () => {
    expect(isValidRecipientEmail("daniel.dwyer123@gmail.com")).toBe(true);
    expect(isValidRecipientEmail("not-an-email")).toBe(false);
  });
});

describe("month-to-date range", () => {
  it("uses the first calendar day through the run date in Europe/London", () => {
    const range = monthToDateRangeInTimeZone(
      new Date("2026-08-28T07:00:00.000Z"),
      "Europe/London",
    );
    expect(range.fromDate).toBe("2026-08-01");
    expect(range.toDate).toBe("2026-08-28");
    expect(range.hour).toBe(8);
    expect(formatCivilDateLong(range.fromDate)).toBe("1 August 2026");
    expect(formatCivilDateLong(range.toDate)).toBe("28 August 2026");
  });

  it("formats sales in major currency units", () => {
    expect(formatMajorCurrency(12345.67, "GBP")).toBe("£12,345.67");
  });
});
