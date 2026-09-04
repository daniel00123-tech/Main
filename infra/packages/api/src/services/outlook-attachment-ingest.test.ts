import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  listApproved: vi.fn(),
  listExcluded: vi.fn(),
  seedPolicy: vi.fn(),
  discoverUsers: vi.fn(),
  listRegistry: vi.fn(),
  markScan: vi.fn(),
  resolveGraph: vi.fn(),
  listMessages: vi.fn(),
  listAttachments: vi.fn(),
  getAttachment: vi.fn(),
  executeOutlook: vi.fn(),
  listMcp: vi.fn(),
  upload: vi.fn(),
  recordEvent: vi.fn(async () => "kie_1"),
  store: vi.fn(),
  search: vi.fn(),
}));

vi.mock("./mailbox-registry", () => ({
  listApprovedAttachmentMailboxes: hoisted.listApproved,
  listExcludedAttachmentMailboxes: hoisted.listExcluded,
  seedPolicyMailboxes: hoisted.seedPolicy,
  discoverCompanyUserMailboxes: hoisted.discoverUsers,
  listCompanyMailboxRegistry: hoisted.listRegistry,
  markMailboxScanResult: hoisted.markScan,
}));

vi.mock("./outlook-graph-access", () => ({
  resolveOutlookGraphAccess: hoisted.resolveGraph,
}));

vi.mock("./microsoft-outlook-graph", async () => {
  const actual = await vi.importActual<typeof import("./microsoft-outlook-graph")>("./microsoft-outlook-graph");
  return {
    ...actual,
    listMailboxMessages: hoisted.listMessages,
    listMessageAttachments: hoisted.listAttachments,
    getMessageAttachmentContent: hoisted.getAttachment,
  };
});

vi.mock("./microsoft-outlook-read", () => ({
  executeOutlookReadTool: hoisted.executeOutlook,
}));

vi.mock("./microsoft-outlook-company-mcp", () => ({
  executeCompanyMcpOutlookRead: hoisted.executeOutlook,
}));

vi.mock("./control-plane", () => ({
  listMcpEnvironments: hoisted.listMcp,
}));

vi.mock("./microsoft-knowledge-bridge", () => ({
  buildMicrosoftMailExternalId: () => "msat-test",
  buildOutlookKnowledgeProvenance: (input: Record<string, unknown>) => input,
  uploadMicrosoftDocumentToKnowledge: hoisted.upload,
}));

vi.mock("./knowledge-ingestion-events", () => ({
  recordKnowledgeIngestionEvent: hoisted.recordEvent,
}));

vi.mock("./knowledge-intake", () => ({
  storeOriginalInKnowledgeIntake: hoisted.store,
  discoverKnowledgeIntakeTarget: vi.fn(async () => ({
    status: "unconfigured",
    last_error: "LANDING_ZONE_GRAPH_UNAVAILABLE",
  })),
  isKnowledgeIntakePath: (path?: string | null) => /INFRA Knowledge Intake/i.test(path ?? ""),
}));

vi.mock("./microsoft-acceptance-knowledge-search", () => ({
  runProductionKnowledgeSearch: hoisted.search,
}));

import { ingestApprovedOutlookAttachments } from "./outlook-attachment-ingest";

function dbStub() {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
  };
}

const pdfBytes = btoa("%PDF-1.4 test");

describe("Outlook attachment ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.seedPolicy.mockResolvedValue([]);
    hoisted.discoverUsers.mockResolvedValue([
      { mailboxAddress: "michael@elvexpropertyservices.com", displayName: "Michael", userId: "u1", role: "finance_team" },
      { mailboxAddress: "sharon@elvexpropertyservices.com", displayName: "Sharon", userId: "u2", role: "office_staff" },
      { mailboxAddress: "lauren@elvexpropertyservices.com", displayName: "Lauren", userId: "u3", role: "office_staff" },
      { mailboxAddress: "william@elvexpropertyservices.com", displayName: "William", userId: "u4", role: "director" },
      { mailboxAddress: "ella@elvexpropertyservices.com", displayName: "Ella Mae", userId: "u5", role: "director" },
    ]);
    hoisted.listRegistry.mockResolvedValue([]);
    hoisted.listExcluded.mockResolvedValue([
      {
        mailbox_address: "william@elvexpropertyservices.com",
        mailbox_type: "user_mailbox",
        display_name: "William",
        enabled_for_attachment_ingestion: 0,
      },
      {
        mailbox_address: "ella@elvexpropertyservices.com",
        mailbox_type: "user_mailbox",
        display_name: "Ella Mae",
        enabled_for_attachment_ingestion: 0,
      },
    ]);
    hoisted.markScan.mockResolvedValue(undefined);
    hoisted.listMcp.mockResolvedValue([{ id: "mcp_el_primary", enabled: true, serviceBindingRef: "EL_BUSINESS_MCP" }]);
    hoisted.upload.mockResolvedValue({ ok: true, documentId: 91, indexed: true, documentStatus: "indexed", chunksIndexed: 4 });
    hoisted.store.mockResolvedValue({
      ok: true,
      via: "durable_fallback",
      storedItemId: "fallback:hash",
      storedUrl: null,
      storedFilename: "stored.pdf",
      siteId: null,
      driveId: null,
      folderId: null,
      landingZoneReady: false,
      warning: "LANDING_ZONE_GRAPH_UNAVAILABLE",
    });
    hoisted.search.mockResolvedValue({
      ok: true,
      hitCount: 1,
      hits: [{ title: "quote.pdf", documentId: 91, snippet: "quote" }],
    });
    hoisted.listApproved.mockResolvedValue([
      {
        id: "mbx_info",
        company_id: "co_el",
        mailbox_address: "info@elvexpropertyservices.com",
        mailbox_type: "shared_mailbox",
        last_checkpoint: null,
      },
    ]);
    hoisted.resolveGraph.mockResolvedValue({
      ok: true,
      accessToken: "token",
      tenantId: "tenant-el",
      source: "test",
    });
  });

  it("indexes a shared-mailbox PDF and skips an inline logo", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-1",
        subject: "RE: Quote request - 19 Lewis Street, Pentre, CF41 7JB",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T15:41:18Z",
        from: { emailAddress: { address: "site@example.com" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      { id: "att-pdf", name: "quote.pdf", contentType: "application/pdf", size: 20_000, isInline: false },
      { id: "att-logo", name: "image001.png", contentType: "image/png", size: 1_200, isInline: true },
    ]);
    hoisted.getAttachment.mockResolvedValue({
      name: "quote.pdf",
      contentType: "application/pdf",
      size: 20_000,
      contentBytes: pdfBytes,
    });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );

    expect(result.counts.mailboxesScanned).toBe(1);
    expect(result.counts.attachmentsDiscovered).toBe(2);
    expect(result.counts.attachmentsIndexed).toBe(1);
    expect(result.counts.attachmentsStored).toBe(1);
    expect(result.counts.skipped).toBe(1);
    expect(result.counts.skippedJunk).toBe(1);
    expect(hoisted.store).toHaveBeenCalledTimes(1);
    expect(result.namedPeople.map((row) => row.name)).toEqual(["Michael", "Sharon", "Lauren", "William", "Ella"]);
    expect(result.namedPeople.find((row) => row.name === "William")?.excluded).toBe(true);
    expect(result.namedPeople.find((row) => row.name === "Ella")?.excluded).toBe(true);
    expect(result.counts.mailboxesExcluded).toBe(2);
    expect(hoisted.upload).toHaveBeenCalledTimes(1);
  });

  it("treats same filename with different content as a new document", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-a",
        subject: "v1",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T13:41:08Z",
        from: { emailAddress: { address: "a@example.com" } },
      },
      {
        id: "msg-b",
        subject: "v2",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T14:41:08Z",
        from: { emailAddress: { address: "b@example.com" } },
      },
    ]);
    hoisted.listAttachments.mockImplementation(async (_cfg: unknown, _mbx: string, messageId: string) => [
      { id: `att-${messageId}`, name: "receipt.pdf", contentType: "application/pdf", size: 10_000, isInline: false },
    ]);
    hoisted.getAttachment.mockImplementation(async (_cfg: unknown, _mbx: string, messageId: string) => ({
      name: "receipt.pdf",
      contentType: "application/pdf",
      size: 10,
      contentBytes: btoa(messageId === "msg-a" ? "content-a" : "content-b"),
    }));

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );
    expect(result.counts.attachmentsIndexed).toBe(2);
    expect(hoisted.upload).toHaveBeenCalledTimes(2);
  });

  it("retries a transient Graph timeout and does not permanently drop the attachment", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-timeout",
        subject: "Fw: Your receipt from Anthropic, PBC #2275-0489-5290",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T13:41:08Z",
        from: { emailAddress: { address: "billing@anthropic.com" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      { id: "att-1", name: "receipt.pdf", contentType: "application/pdf", size: 9000, isInline: false },
    ]);
    hoisted.getAttachment
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        name: "receipt.pdf",
        contentType: "application/pdf",
        size: 9000,
        contentBytes: pdfBytes,
      });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );
    expect(result.counts.attachmentsIndexed).toBe(1);
    expect(hoisted.getAttachment).toHaveBeenCalledTimes(2);
  });

  it("records index write failures without inventing document text", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-fail",
        subject: "broken",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T13:41:08Z",
        from: { emailAddress: { address: "a@example.com" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      { id: "att-x", name: "notes.txt", contentType: "text/plain", size: 100, isInline: false },
    ]);
    hoisted.getAttachment.mockResolvedValue({
      name: "notes.txt",
      contentType: "text/plain",
      size: 100,
      contentBytes: btoa("hello"),
    });
    hoisted.upload.mockResolvedValue({ ok: false, code: "INDEX_TIMEOUT", message: "index timeout" });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );
    expect(result.counts.failed).toBe(1);
    expect(result.counts.attachmentsIndexed).toBe(0);
    expect(JSON.stringify(result)).not.toContain("Caddington");
  });

  it("does not advance the mailbox checkpoint when attachment enumeration fails", async () => {
    hoisted.resolveGraph.mockResolvedValue({
      ok: false,
      code: "AADSTS7000229",
      message: "The client application is missing service principal in the tenant",
    });
    hoisted.executeOutlook.mockImplementation(async (_env: unknown, input: { toolName: string }) => {
      if (input.toolName === "outlook_list_messages") {
        return {
          ok: true,
          result: {
            messages: [
              {
                id: "msg-quote",
                subject: "RE: Quote request - 19 Lewis Street, Pentre, CF41 7JB",
                hasAttachments: true,
                receivedDateTime: "2026-09-04T15:41:18Z",
              },
            ],
          },
        };
      }
      return { ok: false, code: "OUTLOOK_MCP_ATTACHMENT_TOOL_MISSING", message: "no attachment tool" };
    });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );

    expect(result.counts.failed).toBe(1);
    expect(result.counts.attachmentsIndexed).toBe(0);
    expect(hoisted.markScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        success: false,
        checkpoint: null,
        graphAccessible: false,
      }),
    );
  });

  it("indexes when company MCP get-message returns attachment bytes without Graph", async () => {
    hoisted.resolveGraph.mockResolvedValue({
      ok: false,
      code: "AADSTS7000229",
      message: "missing service principal",
    });
    hoisted.executeOutlook.mockImplementation(async (_env: unknown, input: { toolName: string }) => {
      if (input.toolName === "outlook_list_messages") {
        return {
          ok: true,
          result: {
            messages: [
              {
                id: "msg-receipt",
                subject: "Fw: Your receipt from Anthropic, PBC #2275-0489-5290",
                hasAttachments: true,
                receivedDateTime: "2026-09-04T13:41:08Z",
                from: "Ella@elvexpropertyservices.com",
              },
            ],
          },
        };
      }
      if (input.toolName === "outlook_list_attachments") {
        return { ok: false, code: "OUTLOOK_MCP_ATTACHMENT_TOOL_MISSING", message: "no list tool" };
      }
      if (input.toolName === "outlook_get_message") {
        return {
          ok: true,
          result: {
            attachments: [
              {
                id: "att-receipt",
                name: "receipt.pdf",
                contentType: "application/pdf",
                size: 20_000,
                isInline: false,
                contentBytesBase64: pdfBytes,
              },
            ],
          },
        };
      }
      return { ok: false, code: "OUTLOOK_MCP_ATTACHMENT_TOOL_MISSING", message: "no get tool" };
    });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );

    expect(result.counts.attachmentsIndexed).toBe(1);
    expect(result.counts.failed).toBe(0);
    expect(hoisted.upload).toHaveBeenCalledTimes(1);
    expect(hoisted.markScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: true, graphAccessible: false }),
    );
  });

  it("does not ingest another tenant when asked for co_el", async () => {
    hoisted.listApproved.mockResolvedValue([]);
    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );
    expect(result.companyId).toBe("co_el");
    expect(result.counts.mailboxesScanned).toBe(0);
    expect(hoisted.listApproved).toHaveBeenCalledWith(expect.anything(), "co_el");
  });

  it("stores an unsupported business file without indexing it", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-zip",
        subject: "CIS pack",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T11:32:00Z",
        from: { emailAddress: { address: "ellie@barons-group.org" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      { id: "att-zip", name: "statements.zip", contentType: "application/zip", size: 40_000, isInline: false },
    ]);
    hoisted.getAttachment.mockResolvedValue({
      name: "statements.zip",
      contentType: "application/zip",
      size: 40_000,
      contentBytes: btoa("PK zip"),
    });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-03T17:39:03.388Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );
    expect(result.counts.attachmentsStored).toBe(1);
    expect(result.counts.unsupported).toBe(1);
    expect(result.counts.attachmentsIndexed).toBe(0);
    expect(hoisted.store).toHaveBeenCalledTimes(1);
    expect(hoisted.upload).not.toHaveBeenCalled();
  });

  it("does not mark Indexed=Yes when retrieval verification fails", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-docx",
        subject: "How to guide",
        hasAttachments: true,
        receivedDateTime: "2026-04-04T10:00:00Z",
        from: { emailAddress: { address: "william@example.com" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      {
        id: "att-docx",
        name: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 59_000,
        isInline: false,
      },
    ]);
    hoisted.getAttachment.mockResolvedValue({
      name: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 59_000,
      contentBytes: btoa("docx"),
    });
    hoisted.search.mockResolvedValue({ ok: true, hitCount: 0, hits: [] });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-04-01T00:00:00.000Z"),
        windowTo: new Date("2026-09-04T17:39:03.388Z"),
      },
    );
    expect(result.counts.attachmentsStored).toBe(1);
    expect(result.counts.attachmentsIndexed).toBe(0);
    expect(result.counts.failed).toBe(1);
  });

  it("includes Lauren by inherited default and never scans William or Ella", async () => {
    hoisted.listApproved.mockResolvedValue([
      {
        id: "mbx_lauren",
        company_id: "co_el",
        mailbox_address: "lauren@elvexpropertyservices.com",
        mailbox_type: "user_mailbox",
        last_checkpoint: null,
      },
    ]);
    hoisted.listRegistry.mockResolvedValue([
      {
        mailbox_address: "lauren@elvexpropertyservices.com",
        display_name: "Lauren",
        enabled_for_attachment_ingestion: 1,
        enabled_for_mail_search: 0,
        graph_accessible: 0,
      },
      {
        mailbox_address: "william@elvexpropertyservices.com",
        display_name: "William",
        enabled_for_attachment_ingestion: 0,
        enabled_for_mail_search: 0,
        graph_accessible: null,
      },
    ]);
    hoisted.listMessages.mockResolvedValue([]);
    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-08-28T19:00:00.000Z"),
        windowTo: new Date("2026-09-04T20:00:00.000Z"),
      },
    );
    expect(result.namedPeople.find((row) => row.name === "Lauren")?.approvedForAttachmentIngestion).toBe(true);
    expect(result.namedPeople.find((row) => row.name === "William")?.excluded).toBe(true);
    expect(result.namedPeople.find((row) => row.name === "Ella")?.excluded).toBe(true);
    expect(hoisted.listMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailboxAddress: "lauren@elvexpropertyservices.com" }),
    );
    expect(JSON.stringify(hoisted.listMessages.mock.calls)).not.toMatch(/william@|ella@/i);
  });

  it("indexes XLSX and DOCX business documents", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-docs",
        subject: "CIS pack",
        hasAttachments: true,
        receivedDateTime: "2026-09-03T10:32:31Z",
        from: { emailAddress: { address: "ellie@barons-group.org" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      {
        id: "att-xlsx",
        name: "remittance.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 12_000,
        isInline: false,
      },
      {
        id: "att-docx",
        name: "statement.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 15_000,
        isInline: false,
      },
    ]);
    hoisted.getAttachment.mockImplementation(async (_cfg: unknown, _mbx: string, _msg: string, attachmentId: string) => ({
      name: attachmentId === "att-xlsx" ? "remittance.xlsx" : "statement.docx",
      contentType:
        attachmentId === "att-xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 12_000,
      contentBytes: btoa(attachmentId),
    }));
    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-01T00:00:00.000Z"),
        windowTo: new Date("2026-09-04T20:00:00.000Z"),
      },
    );
    expect(result.counts.attachmentsIndexed).toBe(2);
  });

  it("skips unsafe executables without fetching forever", async () => {
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-exe",
        subject: "tool",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T12:00:00Z",
        from: { emailAddress: { address: "a@example.com" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      { id: "att-exe", name: "setup.exe", contentType: "application/x-msdownload", size: 40_000, isInline: false },
    ]);
    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-01T00:00:00.000Z"),
        windowTo: new Date("2026-09-04T20:00:00.000Z"),
      },
    );
    expect(result.counts.skipped).toBe(1);
    expect(result.counts.attachmentsIndexed).toBe(0);
    expect(result.counts.unsupported).toBe(1);
  });

  it("records a storage failure without advancing as indexed", async () => {
    hoisted.store.mockResolvedValueOnce({
      ok: false,
      code: "LANDING_ZONE_UPLOAD_FAILED",
      message: "temporary storage failure",
      via: "none",
      storedItemId: null,
      storedUrl: null,
      warning: "LANDING_ZONE_UPLOAD_FAILED",
    });
    hoisted.listMessages.mockResolvedValue([
      {
        id: "msg-store",
        subject: "quote",
        hasAttachments: true,
        receivedDateTime: "2026-09-04T15:41:18Z",
        from: { emailAddress: { address: "site@example.com" } },
      },
    ]);
    hoisted.listAttachments.mockResolvedValue([
      { id: "att-pdf", name: "quote.pdf", contentType: "application/pdf", size: 20_000, isInline: false },
    ]);
    hoisted.getAttachment.mockResolvedValue({
      name: "quote.pdf",
      contentType: "application/pdf",
      size: 20_000,
      contentBytes: pdfBytes,
    });
    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-09-01T00:00:00.000Z"),
        windowTo: new Date("2026-09-04T20:00:00.000Z"),
      },
    );
    expect(result.counts.failed).toBeGreaterThan(0);
    expect(result.counts.attachmentsIndexed).toBe(0);
    expect(hoisted.markScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false, checkpoint: null }),
    );
  });

  it("never renders a Graph-fail + empty MCP list as Messages scanned: 0", async () => {
    hoisted.listApproved.mockResolvedValue([
      {
        id: "mbx_michael",
        company_id: "co_el",
        mailbox_address: "michael@elvexpropertyservices.com",
        mailbox_type: "user_mailbox",
        display_name: "Michael",
        last_checkpoint: null,
        last_attachment_scan_at: null,
        enabled_for_attachment_ingestion: 1,
      },
    ]);
    hoisted.listRegistry.mockResolvedValue([
      {
        mailbox_address: "michael@elvexpropertyservices.com",
        display_name: "Michael",
        enabled_for_attachment_ingestion: 1,
        enabled_for_mail_search: 0,
        graph_accessible: 0,
        last_attachment_scan_at: null,
      },
    ]);
    hoisted.resolveGraph.mockResolvedValue({
      ok: false,
      code: "AADSTS7000229",
      message: "The client application is missing service principal in the tenant",
    });
    hoisted.executeOutlook.mockResolvedValue({
      ok: true,
      result: { messages: [] },
    });

    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-08-28T19:00:00.000Z"),
        windowTo: new Date("2026-09-04T20:00:00.000Z"),
      },
    );
    const michael = result.namedPeople.find((row) => row.name === "Michael");
    expect(michael?.scanStatus).toBe("FAILED");
    expect(michael?.messagesScanned).toBeNull();
    expect(michael?.messagesScannedLabel).toMatch(/SCAN FAILED/i);
    expect(michael?.messagesScannedLabel).not.toBe("0");
    expect(hoisted.markScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        success: false,
        checkpoint: null,
        mailboxAddress: "michael@elvexpropertyservices.com",
      }),
    );
  });

  it("renders a Graph-proven empty mailbox as successful zero, not SCAN FAILED", async () => {
    hoisted.listApproved.mockResolvedValue([
      {
        id: "mbx_lauren",
        company_id: "co_el",
        mailbox_address: "lauren@elvexpropertyservices.com",
        mailbox_type: "user_mailbox",
        display_name: "Lauren",
        last_checkpoint: null,
        last_attachment_scan_at: null,
        enabled_for_attachment_ingestion: 1,
      },
    ]);
    hoisted.listRegistry.mockResolvedValue([
      {
        mailbox_address: "lauren@elvexpropertyservices.com",
        display_name: "Lauren",
        enabled_for_attachment_ingestion: 1,
        enabled_for_mail_search: 0,
        graph_accessible: 1,
        last_attachment_scan_at: "2026-09-04T20:00:00.000Z",
      },
    ]);
    hoisted.listMessages.mockResolvedValue([]);
    const result = await ingestApprovedOutlookAttachments(
      { DB: dbStub() } as never,
      {
        companyId: "co_el",
        windowFrom: new Date("2026-08-28T19:00:00.000Z"),
        windowTo: new Date("2026-09-04T20:00:00.000Z"),
      },
    );
    const lauren = result.namedPeople.find((row) => row.name === "Lauren");
    expect(lauren?.scanStatus).toBe("HEALTHY");
    expect(lauren?.messagesScanned).toBe(0);
    expect(lauren?.messagesScannedLabel).toBe("0 (successful empty scan)");
    expect(hoisted.markScan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: true, mailboxAddress: "lauren@elvexpropertyservices.com" }),
    );
  });
});
