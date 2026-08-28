import { describe, expect, it } from "vitest";
import {
  applyKnowledgeSourceScopeToSearchArgs,
  resolveKnowledgeSourceScope,
  scopeToKnowledgeFilters,
} from "./knowledge-source-scope";
import {
  assessPdfExtractionQuality,
  stripPdfPageMarkers,
} from "./knowledge-pdf-extraction";
import {
  buildOutlookKnowledgeProvenance,
  buildMicrosoftMailExternalId,
  mapKnowledgeIndexOutcomeToMicrosoftStatus,
} from "./microsoft-knowledge-bridge";

describe("knowledge source scope", () => {
  it("scopes Microsoft 365 only queries", () => {
    const resolved = resolveKnowledgeSourceScope(
      "Search Microsoft 365 only for investments",
    );
    expect(resolved.scope).toBe("MICROSOFT_365");
    expect(resolved.cleanedQuery).toBe("investments");
    expect(resolved.filters).toEqual({ source: "microsoft_365" });
  });

  it("scopes SharePoint queries", () => {
    const resolved = resolveKnowledgeSourceScope("Search SharePoint for Elvex");
    expect(resolved.scope).toBe("SHAREPOINT");
    expect(resolved.cleanedQuery).toBe("Elvex");
    expect(resolved.filters).toEqual({ category: "sharepoint" });
  });

  it("scopes OneDrive queries", () => {
    const resolved = resolveKnowledgeSourceScope(
      "Search OneDrive for financial information",
    );
    expect(resolved.scope).toBe("ONEDRIVE");
    expect(resolved.filters).toEqual({ category: "onedrive" });
  });

  it("scopes shared mailbox queries", () => {
    const resolved = resolveKnowledgeSourceScope(
      "Search the shared mailbox for invoices",
    );
    expect(resolved.scope).toBe("OUTLOOK_SHARED");
    expect(resolved.filters).toEqual({ category: "outlook_shared" });
  });

  it("leaves ambiguous queries unscoped", () => {
    const resolved = resolveKnowledgeSourceScope("Elvex remittance");
    expect(resolved.scope).toBe("ALL");
    expect(resolved.filters).toEqual({});
  });

  it("applies scope filters to search args without overriding explicit filters", () => {
    const scoped = applyKnowledgeSourceScopeToSearchArgs({
      query: "Search Microsoft 365 only for investments",
      category: "sharepoint",
    });
    expect(scoped.scopeApplied).toBe(true);
    expect(scoped.args.query).toBe("investments");
    expect(scoped.args.source).toBe("microsoft_365");
    expect(scoped.args.category).toBe("sharepoint");
  });

  it("maps GOOGLE_DRIVE scope", () => {
    expect(scopeToKnowledgeFilters("GOOGLE_DRIVE")).toEqual({
      source: "google_drive",
    });
  });
});

describe("PDF extraction quality", () => {
  it("detects heading-only PDF extraction", () => {
    const segments = [
      { text: "# Page 1", metadata: { page: 1 } },
      { text: "# Page 2", metadata: { page: 2 } },
      { text: "# Page 3", metadata: { page: 3 } },
      { text: "# Page 4", metadata: { page: 4 } },
    ];
    const assessment = assessPdfExtractionQuality(segments);
    expect(assessment.extractionQuality).toBe("requires_ocr");
    expect(assessment.requiresOcr).toBe(true);
    expect(assessment.fallbackRequired).toBe(true);
    expect(assessment.pagesWithText).toBe(0);
    expect(assessment.pageCount).toBe(4);
  });

  it("accepts normal PDF extraction", () => {
    const segments = [
      {
        text: "# Page 1\nCoal Search report with substantive findings about the site.",
        metadata: { page: 1 },
      },
      {
        text: "# Page 2\nFurther analysis of coal deposits and environmental constraints.",
        metadata: { page: 2 },
      },
    ];
    const assessment = assessPdfExtractionQuality(segments);
    expect(assessment.extractionQuality).toBe("good");
    expect(assessment.requiresOcr).toBe(false);
    expect(assessment.pagesWithText).toBe(2);
  });

  it("strips page markers for substantive length checks", () => {
    expect(stripPdfPageMarkers("# Page 1\nActual content here")).toBe(
      "Actual content here",
    );
  });
});

describe("Outlook parent/attachment provenance", () => {
  it("includes parent message and attachment metadata", () => {
    const provenance = buildOutlookKnowledgeProvenance({
      companyId: "co_caddington",
      tenantId: "tenant-1",
      mailboxAddress: "admin@CaddingtonHoldings.co.uk",
      messageId: "msg-1",
      internetMessageId: "<abc@test>",
      subject: "Test1",
      from: "sender@test",
      to: ["admin@CaddingtonHoldings.co.uk"],
      receivedDateTime: "2026-01-01T00:00:00Z",
      itemKind: "mail_attachment",
      parentMessageId: "msg-1",
      parentKnowledgeDocumentId: 70,
      attachmentId: "att-1",
      attachmentName: "Investment opportunity - Arnold Crescent.pdf",
      hasAttachments: false,
    });
    expect(provenance.parentMessageId).toBe("msg-1");
    expect(provenance.parentKnowledgeDocumentId).toBe(70);
    expect(provenance.attachmentId).toBe("att-1");
    expect(provenance.itemKind).toBe("mail_attachment");
  });

  it("exposes hasAttachments and attachment list on parent email", () => {
    const provenance = buildOutlookKnowledgeProvenance({
      companyId: "co_caddington",
      tenantId: "tenant-1",
      mailboxAddress: "admin@CaddingtonHoldings.co.uk",
      messageId: "msg-1",
      hasAttachments: true,
      attachments: [
        {
          filename: "file.pdf",
          contentType: "application/pdf",
          attachmentId: "att-1",
          knowledgeDocumentId: 71,
          indexingStatus: "indexed",
        },
      ],
    });
    expect(provenance.hasAttachments).toBe(true);
    expect(provenance.attachments).toHaveLength(1);
  });

  it("builds stable mail external ids", () => {
    const messageId = buildMicrosoftMailExternalId({
      mailboxAddress: "admin@test",
      messageId: "msg-1",
    });
    const attachmentId = buildMicrosoftMailExternalId({
      mailboxAddress: "admin@test",
      messageId: "msg-1",
      attachmentId: "att-1",
    });
    expect(messageId).not.toBe(attachmentId);
    expect(messageId.startsWith("msml-")).toBe(true);
    expect(attachmentId.startsWith("msat-")).toBe(true);
  });
});

describe("indexing state mapping", () => {
  it("maps requires OCR to partial microsoft status", () => {
    expect(
      mapKnowledgeIndexOutcomeToMicrosoftStatus({
        indexOk: true,
        requiresOcr: true,
        documentStatus: "requires_ocr",
      }),
    ).toBe("partial");
    expect(
      mapKnowledgeIndexOutcomeToMicrosoftStatus({
        indexOk: true,
        documentStatus: "ocr_limit_exceeded",
      }),
    ).toBe("partial");
  });

  it("maps completed index to indexed", () => {
    expect(
      mapKnowledgeIndexOutcomeToMicrosoftStatus({
        indexOk: true,
        requiresOcr: false,
        documentStatus: "indexed",
      }),
    ).toBe("indexed");
  });
});
