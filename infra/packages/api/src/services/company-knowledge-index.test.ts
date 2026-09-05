import { describe, expect, it } from "vitest";
import {
  knowledgeSearchTokens,
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

  it("prefers the distinctive invoice number over the generic INV prefix", () => {
    expect(knowledgeSearchTokens("INV-02277.pdf")[0]).toBe("02277");
    expect(knowledgeSearchTokens("INV 02277")[0]).toBe("02277");
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

  it("ranks distinctive title tokens instead of the first conversational word", async () => {
    const rows = [
      {
        document_id: 3,
        filename: "random.docx",
        title: "There is a note",
        stored_url: null,
        text: "there there there",
        chunk_index: 0,
      },
      {
        document_id: 9,
        filename: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        title: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        stored_url: "https://example.test/finance-admin",
        text: "Finance admin covers invoice coding and mailbox handling.",
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
      query: "Is there a Finance Admin knowledge document, and what does it cover?",
    });
    expect(hits[0]?.documentId).toBe(9);
  });
});
