import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_UNAVAILABLE,
  groundedDescription,
  isDocumentCatalogueAsk,
  resolveCatalogueLimit,
  resolveCatalogueSort,
  resolveCatalogueSourceFilter,
} from "./document-catalogue";

describe("document catalogue helpers", () => {
  it("routes newest vs latest vs indexed from user text", () => {
    expect(resolveCatalogueSort("show me the newest 10 OneDrive files")).toBe("newest");
    expect(resolveCatalogueSort("what are the latest changed SharePoint documents")).toBe("latest");
    expect(resolveCatalogueSort("what did INFRA index most recently")).toBe("indexed");
  });

  it("does not treat invoice or mailbox asks as catalogue", () => {
    expect(isDocumentCatalogueAsk("newest 10 invoices on Xero")).toBe(false);
    expect(isDocumentCatalogueAsk("latest emails in Outlook")).toBe(false);
    expect(isDocumentCatalogueAsk("newest 10 files on OneDrive")).toBe(true);
    expect(isDocumentCatalogueAsk("latest documents uploaded to Drive")).toBe(true);
  });

  it("caps the listing at 20 and defaults to 10", () => {
    expect(resolveCatalogueLimit("newest files")).toBe(10);
    expect(resolveCatalogueLimit("latest 7 documents")).toBe(7);
    expect(resolveCatalogueLimit("newest 99 files")).toBe(20);
  });

  it("grounds descriptions without inventing text", () => {
    expect(groundedDescription({ summary: "Staff handbook intro" })).toEqual({
      description: "Staff handbook intro",
      descriptionSource: "summary",
    });
    expect(groundedDescription({ chunkText: "Section 1 applies to all staff." }).descriptionSource).toBe(
      "chunks",
    );
    expect(groundedDescription({})).toEqual({
      description: DESCRIPTION_UNAVAILABLE,
      descriptionSource: "unavailable",
    });
  });

  it("filters source names from the ask", () => {
    expect(resolveCatalogueSourceFilter("newest OneDrive files")).toBe("onedrive");
    expect(resolveCatalogueSourceFilter("latest SharePoint documents")).toBe("sharepoint");
    expect(resolveCatalogueSourceFilter("newest Drive files")).toBe("drive");
    expect(resolveCatalogueSourceFilter("newest 10 files")).toBe("all");
  });
});
