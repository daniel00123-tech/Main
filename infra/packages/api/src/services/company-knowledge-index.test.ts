import { describe, expect, it } from "vitest";
import {
  classifyKnowledgeQuery,
  detectKnowledgeConceptFamily,
  knowledgeHitMatchesQuery,
  knowledgeSearchTokens,
  searchCompanyKnowledgeIndex,
  shouldUseLocalCompanyKnowledgeIndex,
} from "./company-knowledge-index";
import { chunkExtractedText } from "./document-text-extract";

type KnowledgeRow = {
  company_id: string;
  document_id: number;
  filename: string | null;
  title: string | null;
  stored_url: string | null;
  external_id?: string | null;
  metadata_json?: string | null;
  text: string;
  chunk_index: number;
};

function likeMatch(value: string, pattern: string): boolean {
  const needle = String(pattern).replace(/^%/, "").replace(/%$/, "").toLowerCase();
  return value.toLowerCase().includes(needle);
}

function knowledgeIndexEnv(rows: KnowledgeRow[]) {
  return {
    DB: {
      prepare: (sql: string) => ({
        run: async () => ({ success: true, meta: {} }),
        bind: (...binds: unknown[]) => ({
          run: async () => ({ success: true, meta: {} }),
          first: async () => null,
          all: async () => {
            if (!sql.includes("company_knowledge_chunks")) return { results: [] };
            const companyId = String(binds[0]);
            const limit = Number(binds[binds.length - 1]);
            const likes = binds.slice(1, -1).map(String);
            const filtered = rows.filter((row) => {
              if (row.company_id !== companyId) return false;
              return likes.some((like, index) => {
                const field = index % 5;
                const value =
                  field === 0
                    ? row.filename ?? ""
                    : field === 1
                      ? row.title ?? ""
                      : field === 2
                        ? row.external_id ?? ""
                        : field === 3
                          ? row.metadata_json ?? ""
                          : row.text;
                return likeMatch(value, like);
              });
            });
            return { results: filtered.slice(0, Number.isFinite(limit) ? limit : 80) };
          },
        }),
      }),
    },
  } as never;
}

function genericInvoiceFlood(count: number, companyId = "co_el"): KnowledgeRow[] {
  return Array.from({ length: count }, (_, index) => ({
    company_id: companyId,
    document_id: 1000 + index,
    filename: `Invoice-batch-${index}.pdf`,
    title: `Invoice-batch-${index}.pdf`,
    stored_url: null,
    text: "This invoice covers standard invoice processing for an invoice customer.",
    chunk_index: 0,
  }));
}

const inv02277Chunks: KnowledgeRow[] = Array.from({ length: 6 }, (_, index) => ({
  company_id: "co_el",
  document_id: 18,
  filename: "INV-02277.pdf",
  title: "INV-02277.pdf",
  stored_url: "https://example.test/inv-02277",
  external_id: "outlook:inv-02277",
  metadata_json: JSON.stringify({ sourceFilename: "INV-02277.pdf" }),
  text:
    index === 0
      ? "ELVEX PROPERTY SERVICES invoice INV-02277 for Davies Group works."
      : "Payment terms and completed works conditions for this invoice.",
  chunk_index: index,
}));

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

  it("classifies identifier queries with a high-value token and a weak prefix", () => {
    const classified = classifyKnowledgeQuery("INV-02277");
    expect(classified.highValueTokens).toContain("02277");
    expect(classified.firstStageTokens).toContain("02277");
    expect(classified.firstStageTokens).not.toContain("inv");
    expect(classified.references.some((row) => row.includes("02277"))).toBe(true);
    expect(knowledgeSearchTokens("INV-02277.pdf")[0]).toBe("02277");
    expect(knowledgeSearchTokens("INV 02277")[0]).toBe("02277");
  });

  it("finds an indexed document by filename token", async () => {
    const env = knowledgeIndexEnv([
      {
        company_id: "co_el",
        document_id: 7,
        filename: "Profit Margin Policy.docx",
        title: "Profit Margin Policy.docx",
        stored_url: "https://elvexpropertyservicesltd.sharepoint.com/file",
        text: "Subcontractors must submit invoices with a unique job reference.",
        chunk_index: 0,
      },
    ]);
    const hits = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "Profit Margin Policy",
    });
    expect(hits[0]?.documentId).toBe(7);
    expect(String(hits[0]?.snippet ?? "")).toMatch(/job reference/i);
  });

  it("ranks distinctive title tokens instead of the first conversational word", async () => {
    const env = knowledgeIndexEnv([
      {
        company_id: "co_el",
        document_id: 3,
        filename: "random.docx",
        title: "There is a note",
        stored_url: null,
        text: "there there there",
        chunk_index: 0,
      },
      {
        company_id: "co_el",
        document_id: 9,
        filename: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        title: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        stored_url: "https://example.test/finance-admin",
        text: "Finance admin covers invoice coding and mailbox handling.",
        chunk_index: 0,
      },
    ]);
    const hits = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "Is there a Finance Admin knowledge document, and what does it cover?",
    });
    expect(hits[0]?.documentId).toBe(9);
  });

  it("returns INV-02277.pdf first for the original identifier despite >250 generic invoice chunks", async () => {
    const env = knowledgeIndexEnv([...genericInvoiceFlood(260), ...inv02277Chunks]);
    const hits = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "INV-02277",
    });
    expect(hits[0]?.documentId).toBe(18);
    expect(hits[0]?.filename).toBe("INV-02277.pdf");
  });

  it("normalizes identifier variants to the same document", async () => {
    const env = knowledgeIndexEnv([...genericInvoiceFlood(80), ...inv02277Chunks]);
    for (const query of ["INV-02277", "inv-02277", "02277", "INV 02277", "INV02277"]) {
      const hits = await searchCompanyKnowledgeIndex(env, { companyId: "co_el", query });
      expect(hits[0]?.documentId, query).toBe(18);
    }
  });

  it.each([
    ["PO-12345", "PO-12345.pdf", 21, "po", "purchase order PO-12345"],
    ["JOB-4821", "JOB-4821.pdf", 22, "job", "job pack JOB-4821"],
    ["QUOTE-9182", "QUOTE-9182.pdf", 23, "quote", "quote QUOTE-9182"],
    ["WO-33771", "WO-33771.pdf", 24, "wo", "works order WO-33771"],
  ])("ranks %s ahead of generic %s matches", async (query, filename, documentId, generic, text) => {
    const flood = Array.from({ length: 80 }, (_, index) => ({
      company_id: "co_el",
      document_id: 3000 + index,
      filename: `${generic}-note-${index}.pdf`,
      title: `${generic} note ${index}`,
      stored_url: null,
      text: `generic ${generic} paperwork and invoice notes`,
      chunk_index: 0,
    }));
    const env = knowledgeIndexEnv([
      ...flood,
      {
        company_id: "co_el",
        document_id: Number(documentId),
        filename,
        title: filename,
        stored_url: null,
        text,
        chunk_index: 0,
      },
    ]);
    const hits = await searchCompanyKnowledgeIndex(env, { companyId: "co_el", query });
    expect(hits[0]?.documentId).toBe(documentId);
    expect(hits[0]?.filename).toBe(filename);
  });

  it("ranks Health and Safety ahead of a generic policy document", async () => {
    const env = knowledgeIndexEnv([
      {
        company_id: "co_el",
        document_id: 10,
        filename: "Profit Margin Policy.docx",
        title: "Profit Margin Policy.docx",
        stored_url: null,
        text: "A profitable margin is required on every job. This profit policy is not a site document.",
        chunk_index: 0,
      },
      {
        company_id: "co_el",
        document_id: 31,
        filename: "Health and Safety Policy (2).docx",
        title: "Health and Safety Policy (2).docx",
        stored_url: null,
        text: "This health and safety policy statement sets out site responsibilities.",
        chunk_index: 0,
      },
    ]);
    const hits = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "What is our health and safety policy?",
    });
    expect(hits[0]?.documentId).toBe(31);
    expect(hits.some((hit) => hit.documentId === 10)).toBe(false);
  });

  it("keeps natural-language policy and remittance retrieval", async () => {
    const env = knowledgeIndexEnv([
      ...genericInvoiceFlood(40),
      {
        company_id: "co_el",
        document_id: 31,
        filename: "Health and Safety Policy (2).docx",
        title: "Health and Safety Policy (2).docx",
        stored_url: null,
        text: "This health and safety policy statement sets out site responsibilities.",
        chunk_index: 0,
      },
      {
        company_id: "co_el",
        document_id: 16,
        filename: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        title: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        stored_url: null,
        text: "Finance admin guide for invoice coding, mailbox handling, and remittance checks.",
        chunk_index: 0,
      },
      {
        company_id: "co_el",
        document_id: 17,
        filename: "Nationwide Property Assistance Ltd Remittance Advice.pdf",
        title: "Nationwide Property Assistance Ltd Remittance Advice.pdf",
        stored_url: null,
        text: "Remittance advice confirming payment of invoices this period.",
        chunk_index: 0,
      },
    ]);
    const safety = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "What is our health and safety policy?",
    });
    expect(safety[0]?.documentId).toBe(31);
    const finance = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "What does the finance admin guide say?",
    });
    expect(finance[0]?.documentId).toBe(16);
    const remittance = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "remittance advice",
    });
    expect(remittance[0]?.documentId).toBe(17);
    const invoices = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "What is the process for invoices?",
    });
    expect(invoices.length).toBeGreaterThan(0);
  });

  it("returns an honest empty set when nothing matches", async () => {
    const env = knowledgeIndexEnv([...genericInvoiceFlood(20), ...inv02277Chunks]);
    const hits = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "intergalactic onboarding fees zzzxq-99999",
    });
    expect(hits).toEqual([]);
  });

  it("retrieves Health & Safety for unnamed workplace-accident concept queries", async () => {
    const env = knowledgeIndexEnv([
      ...genericInvoiceFlood(40),
      ...inv02277Chunks.map((row) => ({
        ...row,
        text: `${row.text} Davies Emergency Response Group invoice for completed works.`,
      })),
      {
        company_id: "co_el",
        document_id: 31,
        filename: "Health and Safety Policy (2).docx",
        title: "Health and Safety Policy (2).docx",
        stored_url: null,
        text: "Report accidents and dangerous occurrences to the responsible person. Gas leaks follow the emergency procedure.",
        chunk_index: 0,
      },
      {
        company_id: "co_el",
        document_id: 16,
        filename: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        title: "Elvex_Finance_Admin_AI_Knowledge_Base.docx",
        stored_url: null,
        text: "Finance admin guide for invoice coding, mailbox handling, and remittance checks. This is the process for invoices.",
        chunk_index: 0,
      },
    ]);
    const queries = [
      "how do we report an accident at work",
      "what is the process if someone has an accident?",
      "how should workplace accidents be reported?",
      "what should staff do after an accident at work?",
      "what is the emergency process for a gas leak?",
      "how do we report a health and safety incident?",
    ];
    for (const query of queries) {
      expect(detectKnowledgeConceptFamily(query)?.id, query).toBe("workplace_safety");
      const hits = await searchCompanyKnowledgeIndex(env, { companyId: "co_el", query });
      expect(hits[0]?.documentId, query).toBe(31);
      expect(hits.some((hit) => hit.documentId === 18), query).toBe(false);
      expect(knowledgeHitMatchesQuery({ title: "Health and Safety Policy (2).docx", snippet: "" }, query)).toBe(true);
      expect(
        knowledgeHitMatchesQuery(
          { title: "INV-02277.pdf", snippet: "Davies Emergency Response Group Fulwood Park" },
          query,
        ),
      ).toBe(false);
    }
    const invoices = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_el",
      query: "What is the process for invoices?",
    });
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices[0]?.documentId).not.toBe(31);
    expect(detectKnowledgeConceptFamily("What is the process for invoices?")).toBeNull();
    expect(detectKnowledgeConceptFamily("INV-02277")).toBeNull();
  });

  it("never returns another tenant's documents", async () => {
    const env = knowledgeIndexEnv([
      ...inv02277Chunks,
      {
        company_id: "co_caddington",
        document_id: 18,
        filename: "INV-02277.pdf",
        title: "INV-02277.pdf",
        stored_url: null,
        text: "Caddington copy of INV-02277 must stay isolated.",
        chunk_index: 0,
      },
      {
        company_id: "co_ht",
        document_id: 99,
        filename: "Health and Safety Policy.docx",
        title: "Health and Safety Policy.docx",
        stored_url: null,
        text: "HT health and safety policy.",
        chunk_index: 0,
      },
    ]);
    const elHits = await searchCompanyKnowledgeIndex(env, { companyId: "co_el", query: "INV-02277" });
    expect(elHits.every((hit) => hit.documentId === 18)).toBe(true);
    const caddington = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_caddington",
      query: "INV-02277",
    });
    expect(caddington[0]?.snippet).toMatch(/Caddington/i);
    const ht = await searchCompanyKnowledgeIndex(env, {
      companyId: "co_ht",
      query: "health and safety policy",
    });
    expect(ht[0]?.documentId).toBe(99);
    const htInvoice = await searchCompanyKnowledgeIndex(env, { companyId: "co_ht", query: "INV-02277" });
    expect(htInvoice).toEqual([]);
  });
});
