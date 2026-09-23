import { describe, expect, it, vi } from "vitest";

vi.mock("./control-plane", () => ({
  listMcpEnvironments: vi.fn(async () => []),
  executeRegisteredMcpTool: vi.fn(),
}));

import {
  isCatalogueListingAsk,
  isDocumentCatalogueTool,
  parseCatalogueIntent,
  rewriteKnowledgeCallForCatalogue,
  sanitizeCatalogueArguments,
  withDocumentCatalogueTools,
  executeListDocuments,
  usableCatalogueTitle,
  verbaliseDocumentCatalogue,
} from "./document-catalogue";

const now = new Date("2026-09-01T12:00:00.000Z");

describe("document catalogue intent", () => {
  it("routes newest/latest listing away from semantic search", () => {
    expect(isCatalogueListingAsk("What's the newest document in OneDrive?")).toBe(true);
    expect(isCatalogueListingAsk("Show me the latest ten files.")).toBe(true);
    expect(isCatalogueListingAsk("What was uploaded today?")).toBe(true);
    expect(isCatalogueListingAsk("What changed this week?")).toBe(true);
    expect(isCatalogueListingAsk("Latest SharePoint PDFs.")).toBe(true);
    expect(isCatalogueListingAsk("What are the newest files and what are they about?")).toBe(true);
    expect(isCatalogueListingAsk("What's the most recently modified policy?")).toBe(true);
    expect(isCatalogueListingAsk("What was added since yesterday?")).toBe(true);
    expect(isCatalogueListingAsk("Show me the latest ten and tell me what they're about.")).toBe(true);
    expect(isCatalogueListingAsk("Find a document about boilers")).toBe(false);
    expect(isCatalogueListingAsk("How many documents can you see?")).toBe(false);
    expect(isCatalogueListingAsk("Summarise this document")).toBe(false);
  });

  it("uses modified time for latest/changed and created time for uploaded", () => {
    const latest = parseCatalogueIntent("What's the newest document in OneDrive?", now);
    expect(latest.source).toBe("onedrive");
    expect(latest.dateField).toBe("modified_at");
    expect(latest.limit).toBe(1);

    const ten = parseCatalogueIntent("Show me the latest ten files.", now);
    expect(ten.limit).toBe(10);
    expect(ten.dateField).toBe("modified_at");

    const uploaded = parseCatalogueIntent("What was uploaded today?", now);
    expect(uploaded.dateField).toBe("created_at");
    expect(uploaded.dateFrom).toBe("2026-09-01");

    const pdfs = parseCatalogueIntent("Latest SharePoint PDFs.", now);
    expect(pdfs.source).toBe("sharepoint");
    expect(pdfs.fileType).toBe("pdf");
  });

  it("rewrites ChatGPT search of newest/latest files onto list_documents", () => {
    const newest = rewriteKnowledgeCallForCatalogue("search", {
      query: "What's the newest document in OneDrive?",
    });
    expect(newest.rewritten).toBe(true);
    expect(newest.toolName).toBe("list_documents");
    expect(newest.arguments.source).toBe("onedrive");
    expect(
      rewriteKnowledgeCallForCatalogue("search_company_knowledge", {
        query: "Show me the latest ten files.",
      }).toolName,
    ).toBe("list_documents");
    expect(
      rewriteKnowledgeCallForCatalogue("search", { query: "Find a document about boilers" }).rewritten,
    ).toBe(false);
  });

  it("does not treat ingestion timestamp as the newest sort key", () => {
    const query = sanitizeCatalogueArguments({ source: "onedrive", sort: "recently_modified", limit: 10 });
    expect(query.dateField).toBe("modified_at");
    expect(query.dateFieldReason).toMatch(/last modified/i);
  });
});

describe("withDocumentCatalogueTools", () => {
  it("advertises list_documents for humans and knowledge scopes", () => {
    const tools = withDocumentCatalogueTools([
      { name: "search", description: "s", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["search", "list_documents"]);
    expect(tools.some((tool) => tool.name === "list_documents")).toBe(true);
    expect(isDocumentCatalogueTool("list_documents")).toBe(true);
    expect(
      withDocumentCatalogueTools(
        [{ name: "search", description: "s", inputSchema: { type: "object", properties: {} } }],
        ["xero.sales.read"],
      ).map((tool) => tool.name),
    ).toEqual(["search"]);
  });
});

describe("executeListDocuments", () => {
  function mockEnv(input: {
    companyId: string;
    connectors: Array<{ definition: string; name: string }>;
    items?: Array<Record<string, unknown>>;
  }) {
    const all = vi.fn(async (sql?: string) => {
      const text = String(sql ?? all.mock.lastCall?.[0] ?? "");
      if (text.includes("FROM connector_instances")) {
        return {
          results: input.connectors.map((row) => ({
            connector_definition_id: row.definition,
            name: row.name,
            auth_status: "connected",
            status: "healthy",
          })),
        };
      }
      if (text.includes("FROM microsoft_knowledge_items")) {
        return { results: input.items ?? [] };
      }
      return { results: [] };
    });
    const prepare = vi.fn((sql: string) => {
      const stmt = {
        bind: vi.fn(() => stmt),
        all: () => all(sql),
        first: async () => {
          if (sql.includes("FROM connector_instances") && sql.includes("LIMIT 1")) return null;
          return null;
        },
        run: async () => ({ success: true }),
      };
      return stmt;
    });
    return {
      DB: { prepare },
    } as never;
  }

  it("returns not_connected when the requested source is not connected", async () => {
    const env = mockEnv({
      companyId: "co_example",
      connectors: [{ definition: "conn_xero", name: "Xero" }],
    });
    const result = await executeListDocuments(env, {
      companyId: "co_example",
      arguments: { source: "onedrive", limit: 1 },
      actor: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("not_connected");
    expect(result.result.documents).toEqual([]);
    expect(result.result.message).toMatch(/not connected/i);
  });

  it("lists Caddington-shaped OneDrive metadata without using search", async () => {
    const env = mockEnv({
      companyId: "co_caddington",
      connectors: [{ definition: "conn_microsoft_365", name: "Microsoft 365" }],
      items: [
        {
          id: "mki_new",
          title: "Newest policy.pdf",
          source_type: "onedrive",
          mime_type: "application/pdf",
          modified_at: "2026-08-27T14:51:03Z",
          created_at: "2026-08-27T18:17:10.094Z",
          web_url: "https://contoso-my.sharepoint.com/personal/a/Newest%20policy.pdf",
          knowledge_document_id: 58,
          external_item_id: "01ABC",
          path: "INFRA Knowledge Test/Newest policy.pdf",
          provenance_json: "{}",
          visibility_status: "active",
          indexing_status: "indexed",
        },
        {
          id: "mki_old",
          title: "Older file.pdf",
          source_type: "onedrive",
          mime_type: "application/pdf",
          modified_at: "2026-08-20T10:00:00Z",
          created_at: "2026-08-27T18:17:36.500Z",
          web_url: "https://contoso-my.sharepoint.com/personal/a/Older%20file.pdf",
          knowledge_document_id: 59,
          external_item_id: "01DEF",
          path: "INFRA Knowledge Test/Older file.pdf",
          provenance_json: "{}",
          visibility_status: "active",
          indexing_status: "indexed",
        },
        {
          id: "mki_sp",
          title: "SharePoint only.pdf",
          source_type: "sharepoint",
          mime_type: "application/pdf",
          modified_at: "2026-08-28T10:00:00Z",
          created_at: "2026-08-27T18:17:36.500Z",
          web_url: "https://contoso.sharepoint.com/sites/a/SharePoint%20only.pdf",
          knowledge_document_id: 60,
          external_item_id: "01GHI",
          path: "Documents/SharePoint only.pdf",
          provenance_json: "{}",
          visibility_status: "active",
          indexing_status: "indexed",
        },
      ],
    });
    const result = await executeListDocuments(env, {
      companyId: "co_caddington",
      arguments: { source: "onedrive", sort: "recently_modified", limit: 10, include_descriptions: false },
      actor: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("ok");
    expect(result.result.backend).toContain("microsoft_knowledge_items");
    expect(result.result.documents.map((doc) => doc.title)).toEqual(["Newest policy.pdf", "Older file.pdf"]);
    expect(result.result.documents[0]?.modifiedAt).toBe("2026-08-27T14:51:03Z");
    expect(result.result.documents[0]?.url).toMatch(/^https:\/\//);
    expect(result.result.dateField).toBe("modified_at");
  });

  it("does not leak another company's rows", async () => {
    const env = mockEnv({
      companyId: "co_el",
      connectors: [{ definition: "conn_onedrive", name: "OneDrive" }],
      items: [],
    });
    const result = await executeListDocuments(env, {
      companyId: "co_el",
      arguments: { source: "onedrive", limit: 10, include_descriptions: false },
      actor: "william",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.documents).toEqual([]);
    expect(result.result.status).toBe("connected_empty");
    expect(result.result.message).toMatch(/semantic search cannot substitute/i);
  });

  it("hides restricted titles from Elvex office staff", async () => {
    const env = mockEnv({
      companyId: "co_el",
      connectors: [{ definition: "conn_onedrive", name: "OneDrive" }],
      items: [
        {
          id: "mki_r",
          title: "Restricted board pack.pdf",
          source_type: "onedrive",
          mime_type: "application/pdf",
          modified_at: "2026-08-27T14:51:03Z",
          created_at: "2026-08-27T18:17:10.094Z",
          web_url: "https://elvex-my.sharepoint.com/Restricted",
          knowledge_document_id: 1,
          external_item_id: "01R",
          path: "Restricted/board.pdf",
          provenance_json: JSON.stringify({ restricted: true }),
          visibility_status: "active",
          indexing_status: "indexed",
        },
      ],
    });
    const result = await executeListDocuments(env, {
      companyId: "co_el",
      arguments: { source: "onedrive", limit: 10, include_descriptions: false },
      actor: "william",
      role: "office_staff",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.documents.map((doc) => doc.title)).not.toContain("Restricted board pack.pdf");
  });
});

describe("usableCatalogueTitle", () => {
  it("keeps the real catalogue filename when a fetch returns Untitled document", () => {
    expect(usableCatalogueTitle("Untitled document", "Elvex Jobs.xlsx")).toBe("Elvex Jobs.xlsx");
    expect(usableCatalogueTitle("", "Rates card 2026 2.pdf")).toBe("Rates card 2026 2.pdf");
    expect(usableCatalogueTitle("Health and Safety Policy (2).docx", "Untitled document")).toBe(
      "Health and Safety Policy (2).docx",
    );
  });
});

describe("verbaliseDocumentCatalogue", () => {
  it("does not invent files when the catalogue is empty", () => {
    const text = verbaliseDocumentCatalogue(
      {
        status: "connected_empty",
        message: "OneDrive is connected, but no document catalogue rows are available to list.",
        documents: [],
      },
      "What's the newest document in OneDrive?",
    );
    expect(text).toMatch(/no document catalogue/i);
    expect(text).not.toMatch(/policy\.pdf/i);
  });

  it("keeps the catalogue filename when describing filename-only items", () => {
    const text = verbaliseDocumentCatalogue(
      {
        status: "ok",
        source: "onedrive",
        dateFieldReason: "Ordered by last modified.",
        documents: [
          {
            title: "Elvex Jobs.xlsx",
            source: "onedrive",
            fileType: "xlsx",
            modifiedAt: "2026-08-18T15:23:09Z",
            url: "https://elvex-my.sharepoint.com/personal/a/Elvex%20Jobs.xlsx",
            description: "Description unavailable — only the filename “Elvex Jobs.xlsx” is available.",
          },
        ],
      },
      "What's the newest document in OneDrive?",
    );
    expect(text).toMatch(/Elvex Jobs\.xlsx/);
    expect(text).not.toMatch(/Untitled document/);
  });
});
