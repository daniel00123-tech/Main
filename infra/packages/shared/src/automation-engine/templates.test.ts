import { describe, expect, it } from "vitest";
import { monthToDateRangeInTimeZone, formatCivilDateLong, formatMajorCurrency } from "./month-to-date";
import {
  AUTOMATION_TEMPLATES,
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  getAutomationTemplate,
  isValidRecipientEmail,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
} from "./templates";
import {
  classifyDocumentActivity,
  isOutlookAttachmentItem,
  rolling24hWindow,
} from "./document-activity";

describe("automation templates", () => {
  it("exposes reusable sales and document activity templates without a tenant id", () => {
    const sales = getAutomationTemplate(XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE);
    const documents = getAutomationTemplate(DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE);
    expect(sales?.type).toBe("XERO_MONTH_TO_DATE_SALES_EMAIL");
    expect(documents?.type).toBe("DOCUMENT_ACTIVITY_DAILY_EMAIL");
    expect(documents?.label).toBe("Daily document activity");
    expect(documents?.defaultSchedule).toEqual({ frequency: "daily", hour: 12, minute: 0 });
    expect(sales?.available).toBe(true);
    expect(documents?.available).toBe(true);
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

describe("document activity window", () => {
  it("uses a rolling 24-hour window rather than midnight", () => {
    const now = new Date("2026-08-28T11:00:00.000Z");
    const window = rolling24hWindow(now);
    expect(window.from.toISOString()).toBe("2026-08-27T11:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-08-28T11:00:00.000Z");
  });

  it("separates newly discovered documents from source-updated documents", () => {
    const windowStart = new Date("2026-08-27T11:00:00.000Z");
    const windowEnd = new Date("2026-08-28T11:00:00.000Z");
    expect(
      classifyDocumentActivity({
        createdAt: "2026-08-28 10:00:00",
        sourceModifiedAt: "2019-01-01T00:00:00.000Z",
        windowStart,
        windowEnd,
      }),
    ).toBe("new");
    expect(
      classifyDocumentActivity({
        createdAt: "2026-08-20T10:00:00.000Z",
        sourceModifiedAt: "2026-08-28T08:00:00.000Z",
        windowStart,
        windowEnd,
      }),
    ).toBe("updated");
    expect(
      classifyDocumentActivity({
        createdAt: "2026-08-20T10:00:00.000Z",
        sourceModifiedAt: "2026-08-20T10:00:00.000Z",
        windowStart,
        windowEnd,
      }),
    ).toBeNull();
  });

  it("does not treat OCR reindex timestamps as source updates", () => {
    expect(
      classifyDocumentActivity({
        createdAt: "2026-08-01T00:00:00.000Z",
        sourceModifiedAt: null,
        windowStart: new Date("2026-08-27T11:00:00.000Z"),
        windowEnd: new Date("2026-08-28T11:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("counts Outlook attachments and excludes mail messages", () => {
    expect(isOutlookAttachmentItem({ externalId: "msat-abc", externalItemId: "msg|att" })).toBe(true);
    expect(isOutlookAttachmentItem({ externalId: "msml-abc", itemKind: "mail_message" })).toBe(false);
  });
});
