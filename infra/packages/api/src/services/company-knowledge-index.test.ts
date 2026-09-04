import { describe, expect, it } from "vitest";
import {
  searchCompanyKnowledgeIndex,
  shouldUseLocalCompanyKnowledgeIndex,
} from "./company-knowledge-index";
import { chunkExtractedText } from "./document-text-extract";

describe("company knowledge index", () => {
  it("uses the local extract/chunk path only for EL Business MCP", () => {
    expect(shouldUseLocalCompanyKnowledgeIndex({ serviceBindingRef: "EL_BUSINESS_MCP" })).toBe(true);
    expect(shouldUseLocalCompanyKnowledgeIndex({ serviceBindingRef: "CADDINGTON_MCP" })).toBe(false);
    expect(shouldUseLocalCompanyKnowledgeIndex({ serviceBindingRef: "HT_BUSINESS_MCP" })).toBe(false);
  });

  it("chunks extracted attachment text so retrieval is not metadata-only", () => {
    const chunks = chunkExtractedText(
      "doc-1",
      "Profit margin policy\n\nSubcontractors must submit invoices with a unique job reference before payment is released.",
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => /subcontractors must submit invoices/i.test(chunk.text))).toBe(true);
  });

  it("finds an indexed document by filename token", async () => {
    const rows = [
      {
        document_id: 7,
        filename: "Profit Margin Policy.docx",
        title: "Profit Margin Policy.docx",
        stored_url: "https://elvexpropertyservicesltd.sharepoint.com/file",
        text: "Subcontractors must submit invoices with a unique job reference.",
        chunk_index: 0,
      },
    ];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          run: async () => ({ success: true, meta: {} }),
          bind: () => ({
            run: async () => ({ success: true, meta: {} }),
            first: async () => null,
            all: async () => ({ results: sql.includes("company_knowledge_chunks") ? rows : [] }),
          }),
        }),
      },
    } as never;
    const hits = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "Profit Margin Policy",
    });
    expect(hits[0]?.documentId).toBe(7);
    expect(String(hits[0]?.snippet ?? "")).toMatch(/job reference/i);
  });
});
