import { describe, expect, it } from "vitest";
import { monthToDateRangeInTimeZone, formatCivilDateLong, formatMajorCurrency } from "./month-to-date";
import {
  AUTOMATION_TEMPLATES,
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
  getAutomationTemplate,
  isValidRecipientEmail,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
} from "./templates";
import {
  classifyKnowledgeIngestionOutcome,
  classifyKnowledgeIngestionSource,
  classifyKnowledgePipelineHealth,
  groupKnowledgeSourceCounts,
  isSafeHttpUrl,
  knowledgeIngestionGapWarning,
  resolveKnowledgeIngestionWindow,
  safeIngestionFailureReason,
  summariseKnowledgeIngestion,
} from "./knowledge-ingestion";
import { renderKnowledgeIngestionReportEmail } from "../email/knowledge-ingestion-email";
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
    const knowledge = getAutomationTemplate(KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE);
    expect(knowledge?.label).toBe("Daily knowledge activity");
    expect(knowledge?.defaultSchedule).toEqual({ frequency: "daily", hour: 8, minute: 0 });
    expect(knowledge?.defaultTimezone).toBe("Europe/London");
    expect(knowledge?.available).toBe(true);
    expect(JSON.stringify(AUTOMATION_TEMPLATES)).not.toMatch(/co_caddington|ht-business|elvex|co_el/i);
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

describe("knowledge ingestion window and classification", () => {
  it("uses the previous successful window and falls back to 24 hours", () => {
    const now = new Date("2026-09-04T17:00:00.000Z");
    const fromPrior = resolveKnowledgeIngestionWindow(now, {
      windowTo: "2026-09-03T07:00:00.000Z",
    });
    expect(fromPrior.initialLookback).toBe(false);
    expect(fromPrior.from.toISOString()).toBe("2026-09-03T07:00:00.000Z");
    expect(fromPrior.to.toISOString()).toBe("2026-09-04T17:00:00.000Z");

    const first = resolveKnowledgeIngestionWindow(now, null);
    expect(first.initialLookback).toBe(true);
    expect(first.from.toISOString()).toBe("2026-09-03T17:00:00.000Z");
  });

  it("groups OneDrive, SharePoint, and approved email attachments without inventing links", () => {
    expect(classifyKnowledgeIngestionSource({ sourceType: "onedrive" })).toBe("onedrive");
    expect(
      classifyKnowledgeIngestionSource({
        sourceType: "sharepoint",
        webUrl: "https://elvex-my.sharepoint.com/personal/a/File.xlsx",
      }),
    ).toBe("onedrive");
    expect(
      classifyKnowledgeIngestionSource({
        sourceType: "outlook_shared",
        externalId: "msat-1",
        itemKind: "mail_attachment",
      }),
    ).toBe("outlook_attachments");
    expect(
      classifyKnowledgeIngestionSource({
        sourceType: "outlook_shared",
        externalId: "msml-1",
        itemKind: "mail_message",
      }),
    ).toBeNull();
    expect(isSafeHttpUrl("https://elvex-my.sharepoint.com/personal/a/File.xlsx")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
  });

  it("distinguishes discovered, indexed, duplicate, and failed ingestion", () => {
    expect(
      classifyKnowledgeIngestionOutcome({
        status: "catalogue",
        extracted: true,
        indexed: true,
      }),
    ).toBe("indexed");
    expect(
      classifyKnowledgeIngestionOutcome({
        status: "pending",
        extracted: false,
        indexed: false,
      }),
    ).toBe("discovered");
    expect(
      classifyKnowledgeIngestionOutcome({
        indexingStatus: "skipped",
        extracted: true,
        indexed: false,
      }),
    ).toBe("duplicate");
    expect(
      classifyKnowledgeIngestionOutcome({
        indexingStatus: "failed",
        extracted: false,
        indexed: false,
      }),
    ).toBe("failed");
    expect(safeIngestionFailureReason({ indexingStatus: "unsupported" })).toBe("unsupported format");
    expect(safeIngestionFailureReason({ indexingStatus: "failed", extracted: false })).toBe("empty content");
    expect(safeIngestionFailureReason({ status: "excluded_protected" })).toBe(
      "skipped (protected or excluded)",
    );
  });

  it("summarises source counts and omits zero sources", () => {
    const summary = summariseKnowledgeIngestion([
      {
        id: "1",
        title: "Jobs.xlsx",
        sourceKey: "onedrive",
        sourceLabel: "OneDrive",
        provider: "Microsoft 365",
        location: null,
        mailbox: null,
        parentSubject: null,
        sender: null,
        discoveredAt: "2026-09-04T10:00:00.000Z",
        modifiedAt: "2026-09-04T10:00:00.000Z",
        discovered: true,
        extracted: true,
        indexed: true,
        chunkCount: 14,
        outcome: "indexed",
        failureReason: null,
        url: "https://elvex-my.sharepoint.com/personal/a/Jobs.xlsx",
      },
      {
        id: "2",
        title: "Quote.pdf",
        sourceKey: "outlook_attachments",
        sourceLabel: "Email attachments",
        provider: "Microsoft 365",
        location: null,
        mailbox: "info@example.com",
        parentSubject: "Quote",
        sender: "ops@example.com",
        discoveredAt: "2026-09-04T11:00:00.000Z",
        modifiedAt: null,
        discovered: true,
        extracted: false,
        indexed: false,
        chunkCount: null,
        outcome: "failed",
        failureReason: "empty content",
        url: null,
      },
    ]);
    expect(summary).toEqual({
      discoveredCount: 2,
      indexedCount: 1,
      chunkTotal: 14,
      duplicateCount: 0,
      failedCount: 1,
      updatedCount: 0,
      sourceObservedCount: 0,
      missedCount: 0,
    });
    expect(groupKnowledgeSourceCounts([
      { sourceKey: "onedrive" } as never,
      { sourceKey: "onedrive" } as never,
    ])).toEqual([{ key: "onedrive", label: "OneDrive", count: 2 }]);
  });

  it("renders empty and failed knowledge activity emails", () => {
    const empty = renderKnowledgeIngestionReportEmail({
      companyDisplayName: "EL Business",
      reportDateLabel: "4 September 2026",
      windowFromLabel: "3 September 2026 18:00 Europe/London",
      windowToLabel: "4 September 2026 18:00 Europe/London",
      manual: true,
      discoveredCount: 0,
      indexedCount: 0,
      chunkTotal: null,
      duplicateCount: 0,
      failedCount: 0,
      sourceCounts: [],
      documents: [],
      failures: [],
      omittedDocuments: 0,
      portalUrl: "https://app.infrastack.app/portal/el-business/automations",
    });
    expect(empty.subject).toBe(
      "INFRA — EL Business Daily Knowledge Activity — 4 September 2026 (manual test)",
    );
    expect(empty.text).toContain("No new documents were added to the knowledge base");
    expect(empty.text).toContain("This run completed successfully.");
    expect(empty.text).not.toMatch(/Caddington|co_caddington|HT Business/i);

    const populated = renderKnowledgeIngestionReportEmail({
      companyDisplayName: "EL Business",
      reportDateLabel: "4 September 2026",
      windowFromLabel: "3 September 2026 08:00 Europe/London",
      windowToLabel: "4 September 2026 08:00 Europe/London",
      manual: false,
      discoveredCount: 1,
      indexedCount: 1,
      chunkTotal: 8,
      duplicateCount: 0,
      failedCount: 1,
      sourceCounts: [{ label: "OneDrive", count: 1 }],
      documents: [
        {
          title: "Jobs.xlsx",
          sourceLabel: "OneDrive",
          indexed: true,
          chunkCount: 8,
          modifiedAt: "2026-08-18T15:23:09Z",
          url: "https://elvex-my.sharepoint.com/personal/a/Jobs.xlsx",
          location: null,
          mailbox: null,
          parentSubject: null,
          sender: null,
          failureReason: null,
        },
      ],
      failures: [
        {
          title: "Broken.pdf",
          sourceLabel: "OneDrive",
          indexed: false,
          chunkCount: null,
          modifiedAt: null,
          url: null,
          location: null,
          mailbox: null,
          parentSubject: null,
          sender: null,
          failureReason: "extraction failed",
        },
      ],
      omittedDocuments: 0,
      portalUrl: "https://app.infrastack.app/portal/el-business/automations",
    });
    expect(populated.subject).toBe("INFRA — EL Business Daily Knowledge Activity — 4 September 2026");
    expect(populated.text).toContain("Successfully indexed: 1");
    expect(populated.text).toContain("Chunks: 8");
    expect(populated.text).toContain("FAILED / NEEDS ATTENTION");
    expect(populated.text).toContain("extraction failed");
    expect(populated.html).toContain("https://elvex-my.sharepoint.com/personal/a/Jobs.xlsx");

    const corrected = renderKnowledgeIngestionReportEmail({
      companyDisplayName: "EL Business",
      reportDateLabel: "4 September 2026",
      windowFromLabel: "3 September 2026 18:39 Europe/London",
      windowToLabel: "4 September 2026 18:39 Europe/London",
      manual: true,
      discoveredCount: 2,
      indexedCount: 0,
      chunkTotal: null,
      updatedCount: 0,
      sourceObservedCount: 2,
      missedCount: 2,
      sourceCounts: [{ label: "Email attachments", count: 2 }],
      documents: [
        {
          title: "Attachment on: Quote request",
          sourceLabel: "Email attachments",
          indexed: false,
          chunkCount: null,
          modifiedAt: "2026-09-04T15:41:18Z",
          url: null,
          location: null,
          mailbox: "info@elvexpropertyservices.com",
          parentSubject: "Quote request",
          sender: null,
          failureReason: "EL Outlook attachments are not auto-ingested into company knowledge",
        },
      ],
      failures: [],
      omittedDocuments: 0,
      portalUrl: "https://app.infrastack.app/portal/el-business/automations",
      subjectOverride: "INFRA — EL Business Daily Knowledge Activity — Corrected Test",
      correctionPreamble: "This corrects the 4 September 2026 manual test that reported zero new documents.",
    });
    expect(corrected.subject).toBe("INFRA — EL Business Daily Knowledge Activity — Corrected Test");
    expect(corrected.text).toContain("Source activity not indexed: 2");
    expect(corrected.text).toContain("This corrects the 4 September 2026 manual test");
    expect(corrected.html).toContain("Source activity not indexed");
  });

  it("marks discovered>0 indexed=0 as a degraded attachment gap unless every item was a legitimate skip", () => {
    expect(
      classifyKnowledgePipelineHealth({
        jobOk: true,
        discoveredCount: 2,
        indexedCount: 0,
        failedCount: 2,
      }),
    ).toBe("degraded");
    expect(
      knowledgeIngestionGapWarning({
        discoveredCount: 2,
        indexedCount: 0,
        failedCount: 2,
      }),
    ).toBe("WARNING — ATTACHMENT INGESTION GAP");
    expect(
      classifyKnowledgePipelineHealth({
        jobOk: true,
        discoveredCount: 2,
        indexedCount: 0,
        failedCount: 0,
        legitimateSkipCount: 2,
      }),
    ).toBe("healthy");
    expect(
      classifyKnowledgePipelineHealth({
        jobOk: false,
        discoveredCount: 0,
        indexedCount: 0,
        failedCount: 0,
      }),
    ).toBe("failed");
  });
});
