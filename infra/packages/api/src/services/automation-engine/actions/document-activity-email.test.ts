import { describe, expect, it, vi, beforeEach } from "vitest";
import { DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE } from "@infra/shared";
import { AutomationActionError } from "./errors";

vi.mock("../../control-plane", () => ({
  getCompanyById: vi.fn(async () => ({
    id: "co_example",
    slug: "example",
    name: "Example Ltd",
  })),
  listMcpEnvironments: vi.fn(async () => []),
  recordAuditEvent: vi.fn(),
}));

vi.mock("../../email/send-transactional", () => ({
  sendTransactionalEmail: vi.fn(),
}));

vi.mock("../../usage", () => ({
  recordUsageEvent: vi.fn(),
}));

vi.mock("../document-activity-query", () => ({
  queryDocumentActivity: vi.fn(),
}));

import { sendTransactionalEmail } from "../../email/send-transactional";
import { queryDocumentActivity } from "../document-activity-query";
import { executeDocumentActivityDailyEmail } from "./document-activity-email";

const ctx = {
  companyId: "co_example",
  companySlug: "example",
  runId: "aur_docs",
  initiatedBy: "admin@example.com",
  serviceIdentityId: null,
  automation: {
    id: "aut_docs",
    companyId: "co_example",
    name: "Daily document activity",
    timezone: "Europe/London",
    configuration: {
      handler: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
      templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
      parameters: { recipientEmail: "admin@example.com" },
    },
  },
} as never;

describe("document activity daily email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails without sending email when the knowledge store is unavailable", async () => {
    vi.mocked(queryDocumentActivity).mockRejectedValueOnce(new Error("DOCUMENT_STORE_UNAVAILABLE"));

    await expect(executeDocumentActivityDailyEmail({} as never, ctx)).rejects.toMatchObject({
      code: "DOCUMENT_STORE_UNAVAILABLE",
      message: "We couldn't retrieve document activity.",
    });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("does not claim zero documents when the store fails", async () => {
    vi.mocked(queryDocumentActivity).mockRejectedValueOnce(new Error("DOCUMENT_STORE_UNAVAILABLE"));
    try {
      await executeDocumentActivityDailyEmail({} as never, ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(AutomationActionError);
      expect((err as AutomationActionError).result?.totalCount).toBeUndefined();
    }
  });

  it("sends a company-aware report from existing metadata", async () => {
    vi.mocked(queryDocumentActivity).mockResolvedValueOnce({
      companyId: "co_example",
      windowFrom: "2026-08-27T11:00:00.000Z",
      windowTo: "2026-08-28T11:00:00.000Z",
      sourceCounts: [
        { key: "google_drive", label: "Google Drive", count: 711 },
        { key: "onedrive", label: "OneDrive", count: 9 },
        { key: "sharepoint", label: "SharePoint", count: 4 },
        { key: "outlook_attachments", label: "Outlook attachments", count: 1 },
      ],
      totalCount: 725,
      newCount: 1,
      updatedCount: 0,
      newDocuments: [
        {
          title: "Supplier Agreement.pdf",
          sourceKey: "sharepoint",
          sourceLabel: "SharePoint",
          kind: "new",
        },
      ],
      updatedDocuments: [],
      canDistinguishNewUpdated: true,
      sourcesQueried: ["microsoft_knowledge_items", "mcp_knowledge_documents"],
      sourcesUnavailable: [],
      triggeredProviderScan: false,
    });
    vi.mocked(sendTransactionalEmail).mockResolvedValueOnce({ id: "email_1", sent: true });

    const result = await executeDocumentActivityDailyEmail(
      { PORTAL_BASE_DOMAIN: "infra-web.pages.dev" } as never,
      ctx,
    );
    expect(result.summary).toBe("Document activity report sent");
    expect(result.result.totalCount).toBe(725);
    expect(result.result.triggeredProviderScan).toBe(false);
    expect(vi.mocked(sendTransactionalEmail).mock.calls[0]?.[2]).toMatchObject({
      companyId: "co_example",
      type: "DOCUMENT_ACTIVITY_REPORT",
      recipient: "admin@example.com",
    });
    expect(String(vi.mocked(sendTransactionalEmail).mock.calls[0]?.[2]?.subject)).toContain(
      "Example Ltd",
    );
    expect(String(vi.mocked(sendTransactionalEmail).mock.calls[0]?.[2]?.bodyText)).toContain(
      "Google Drive",
    );
    expect(String(vi.mocked(sendTransactionalEmail).mock.calls[0]?.[2]?.bodyText)).not.toMatch(
      /aur_docs|chunk|vector/i,
    );
  });

  it("keeps the report when email delivery fails", async () => {
    vi.mocked(queryDocumentActivity).mockResolvedValueOnce({
      companyId: "co_example",
      windowFrom: "2026-08-27T11:00:00.000Z",
      windowTo: "2026-08-28T11:00:00.000Z",
      sourceCounts: [{ key: "google_drive", label: "Google Drive", count: 10 }],
      totalCount: 10,
      newCount: 0,
      updatedCount: 0,
      newDocuments: [],
      updatedDocuments: [],
      canDistinguishNewUpdated: true,
      sourcesQueried: ["mcp_knowledge_documents"],
      sourcesUnavailable: [],
      triggeredProviderScan: false,
    });
    vi.mocked(sendTransactionalEmail).mockResolvedValueOnce({
      id: "email_2",
      sent: false,
      error: "graph failed",
    });

    await expect(executeDocumentActivityDailyEmail({} as never, ctx)).rejects.toMatchObject({
      code: "EMAIL_DELIVERY_FAILED",
      result: { totalCount: 10, emailSent: false },
    });
  });
});
