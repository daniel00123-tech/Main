import { describe, expect, it, vi, beforeEach } from "vitest";
import { KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE } from "@infra/shared";
import { AutomationActionError } from "./errors";

vi.mock("../../control-plane", () => ({
  getCompanyById: vi.fn(async () => ({
    id: "co_el",
    slug: "el-business",
    name: "EL Business",
  })),
}));

vi.mock("../../email/send-transactional", () => ({
  sendTransactionalEmail: vi.fn(),
}));

vi.mock("../../usage", () => ({
  recordUsageEvent: vi.fn(),
}));

vi.mock("../knowledge-ingestion-query", () => ({
  queryKnowledgeIngestionActivity: vi.fn(),
}));

vi.mock("../store", () => ({
  getAutomationRun: vi.fn(async () => ({
    id: "aur_el",
    triggerType: "manual",
    status: "running",
  })),
  listAutomationRuns: vi.fn(async () => []),
}));

vi.mock("../../outlook-attachment-ingest", () => ({
  ingestApprovedOutlookAttachments: vi.fn(async () => ({
    companyId: "co_el",
    counts: {
      messagesScanned: 11,
      messagesWithAttachments: 3,
      attachmentsDiscovered: 3,
      attachmentsStored: 0,
      attachmentsIndexed: 0,
      duplicates: 0,
      skipped: 0,
      skippedJunk: 0,
      unsupported: 0,
      failed: 3,
    },
    mailboxes: [],
    excludedMailboxes: [],
    namedPeople: [],
    registry: [],
  })),
}));

import { sendTransactionalEmail } from "../../email/send-transactional";
import { queryKnowledgeIngestionActivity } from "../knowledge-ingestion-query";
import { executeKnowledgeIngestionDailyEmail } from "./knowledge-ingestion-email";

const ctx = {
  companyId: "co_el",
  companySlug: "el-business",
  runId: "aur_el",
  initiatedBy: "system:el-knowledge-activity",
  serviceIdentityId: null,
  automation: {
    id: "aut_el_knowledge",
    companyId: "co_el",
    name: "Daily EL knowledge activity",
    timezone: "Europe/London",
    configuration: {
      handler: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
      templateKey: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
      parameters: { recipientEmail: "admin@example.com" },
    },
  },
} as never;

describe("knowledge ingestion daily email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not send when the knowledge store is unavailable", async () => {
    vi.mocked(queryKnowledgeIngestionActivity).mockRejectedValueOnce(new Error("DOCUMENT_STORE_UNAVAILABLE"));
    await expect(executeKnowledgeIngestionDailyEmail({} as never, ctx)).rejects.toMatchObject({
      code: "DOCUMENT_STORE_UNAVAILABLE",
    });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("sends a company-isolated manual report using the configured recipient", async () => {
    vi.mocked(queryKnowledgeIngestionActivity).mockResolvedValueOnce({
      companyId: "co_el",
      windowFrom: "2026-09-03T17:00:00.000Z",
      windowTo: "2026-09-04T17:00:00.000Z",
      initialLookback: true,
      documents: [],
      sourceCounts: [],
      discoveredCount: 0,
      indexedCount: 0,
      chunkTotal: null,
      duplicateCount: 0,
      failedCount: 0,
      sourcesQueried: ["microsoft_index_items"],
      sourcesUnavailable: [],
      scannedSourceTypes: ["onedrive"],
      triggeredProviderScan: false,
    });
    vi.mocked(sendTransactionalEmail).mockResolvedValueOnce({ id: "email_el", sent: true });

    const result = await executeKnowledgeIngestionDailyEmail(
      { PORTAL_PUBLIC_ORIGIN: "https://app.infrastack.app" } as never,
      ctx,
    );
    expect(result.summary).toContain("manual test");
    expect(result.result.companyId).toBe("co_el");
    expect(result.result.recipientEmail).toBe("admin@example.com");
    expect(result.result.emailSent).toBe(true);
    const sent = vi.mocked(sendTransactionalEmail).mock.calls[0]?.[2];
    expect(sent).toMatchObject({
      companyId: "co_el",
      type: "DOCUMENT_ACTIVITY_REPORT",
      recipient: "admin@example.com",
    });
    expect(String(sent?.subject)).toContain("EL Business Daily Knowledge Activity");
    expect(String(sent?.subject)).toContain("manual test");
    expect(String(sent?.bodyText)).toMatch(/MESSAGES SCANNED:\s*11/);
    expect(String(sent?.bodyText)).toContain("Attachments discovered: 3");
    expect(String(sent?.bodyText)).toContain("Attachments failed: 3");
    expect(String(sent?.bodyText)).not.toMatch(/Caddington|co_caddington|HT Business/i);
  });

  it("keeps the report when email delivery fails", async () => {
    vi.mocked(queryKnowledgeIngestionActivity).mockResolvedValueOnce({
      companyId: "co_el",
      windowFrom: "2026-09-03T17:00:00.000Z",
      windowTo: "2026-09-04T17:00:00.000Z",
      initialLookback: true,
      documents: [],
      sourceCounts: [],
      discoveredCount: 0,
      indexedCount: 0,
      chunkTotal: null,
      duplicateCount: 0,
      failedCount: 0,
      sourcesQueried: ["microsoft_index_items"],
      sourcesUnavailable: [],
      scannedSourceTypes: ["onedrive"],
      triggeredProviderScan: false,
    });
    vi.mocked(sendTransactionalEmail).mockResolvedValueOnce({
      id: "email_fail",
      sent: false,
      error: "graph failed",
    });

    await expect(executeKnowledgeIngestionDailyEmail({} as never, ctx)).rejects.toBeInstanceOf(
      AutomationActionError,
    );
  });
});
