import { describe, expect, it, vi, beforeEach } from "vitest";

const control = vi.hoisted(() => ({
  getCompanyById: vi.fn(async (db: unknown, companyId: string) => ({
    id: companyId,
    slug: companyId === "co_el" ? "el-business" : "other",
    name: companyId === "co_el" ? "EL Business" : "Other Co",
  })),
  listMcpEnvironments: vi.fn(async (_db: unknown, companyId: string) =>
    companyId === "co_el"
      ? [{ id: "mcp_el_primary", enabled: true, serviceBindingRef: "EL_BUSINESS_MCP" }]
      : [],
  ),
  executeRegisteredMcpTool: vi.fn(),
}));

vi.mock("../control-plane", () => control);

import { queryKnowledgeIngestionActivity } from "./knowledge-ingestion-query";

function mockDb(rowsBySql: Array<{ match?: RegExp; rows: Array<Record<string, unknown>> }>) {
  const exec = (sql: string) => ({
    all: async () => {
      const hit = rowsBySql.find((item) => !item.match || item.match.test(sql));
      return { results: hit?.rows ?? [] };
    },
    run: async () => ({ success: true }),
    first: async () => null,
  });
  return {
    prepare: vi.fn((sql: string) => ({
      ...exec(sql),
      bind: () => exec(sql),
    })),
  } as unknown as D1Database;
}

describe("knowledge ingestion query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    control.executeRegisteredMcpTool.mockResolvedValue({ status: 404 });
  });

  it("scopes Infra Microsoft rows to the requested company and ignores other tenants", async () => {
    const env = {
      DB: mockDb([
        {
          match: /microsoft_knowledge_items/,
          rows: [
            {
              id: "ms_el_1",
              title: "EL only.pdf",
              source_type: "onedrive",
              knowledge_document_id: 9,
              created_at: "2026-09-04T10:00:00.000Z",
              modified_at: "2026-09-04T10:00:00.000Z",
              indexed_at: "2026-09-04T10:05:00.000Z",
              indexing_status: "indexed",
              external_id: "msod-1",
              external_item_id: "item-1",
              web_url: "https://elvex-my.sharepoint.com/personal/a/EL%20only.pdf",
              path: "/EL only.pdf",
              provenance_json: JSON.stringify({ chunkCount: 7 }),
            },
          ],
        },
      ]),
    } as never;

    const report = await queryKnowledgeIngestionActivity(env, {
      companyId: "co_el",
      windowFrom: new Date("2026-09-03T17:00:00.000Z"),
      windowTo: new Date("2026-09-04T17:00:00.000Z"),
    });
    expect(report.companyId).toBe("co_el");
    expect(report.triggeredProviderScan).toBe(false);
    expect(report.documents.map((item) => item.title)).toEqual(["EL only.pdf"]);
    expect(report.documents[0]?.indexed).toBe(true);
    expect(report.documents[0]?.chunkCount).toBe(7);
    expect(report.sourceCounts.find((row) => row.key === "onedrive")?.count).toBe(1);
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining("company_id = ?"));
    expect(control.listMcpEnvironments).toHaveBeenCalledWith(env.DB, "co_el");
  });

  it("reads EL MCP index rows, skips duplicates, and sanitises failed reasons", async () => {
    control.executeRegisteredMcpTool.mockImplementation(async (_env, input) => {
      const sql = String(input.arguments?.sql ?? "");
      if (sql.includes("DISTINCT source_type")) {
        return { status: 200, data: { result: { rows: [{ source_type: "onedrive" }] } } };
      }
      if (sql.includes("knowledge_chunks")) {
        return { status: 200, data: { result: { rows: [{ knowledge_document_id: "item-1", chunk_count: 4 }] } } };
      }
      if (sql.includes("microsoft_index_items")) {
        return {
          status: 200,
          data: {
            result: {
              rows: [
                {
                  item_id: "item-1",
                  filename: "Jobs.xlsx",
                  source_type: "onedrive",
                  web_url: "https://elvex-my.sharepoint.com/personal/a/Jobs.xlsx",
                  status: "catalogue",
                  created_at: "2026-09-04T09:00:00.000Z",
                  modified_at: "2026-09-04T09:00:00.000Z",
                  extracted: 1,
                  extracted_chars: 1200,
                },
                {
                  item_id: "item-1",
                  filename: "Jobs.xlsx",
                  source_type: "onedrive",
                  web_url: "https://elvex-my.sharepoint.com/personal/a/Jobs.xlsx",
                  status: "catalogue",
                  created_at: "2026-09-04T09:00:00.000Z",
                  extracted: 1,
                },
                {
                  item_id: "item-2",
                  filename: "Broken.pdf",
                  source_type: "onedrive",
                  status: "failed",
                  created_at: "2026-09-04T12:00:00.000Z",
                  extracted: 0,
                  extracted_chars: 0,
                },
              ],
            },
          },
        };
      }
      return { status: 404 };
    });

    const env = { DB: mockDb([]) } as never;
    const report = await queryKnowledgeIngestionActivity(env, {
      companyId: "co_el",
      windowFrom: new Date("2026-09-03T17:00:00.000Z"),
      windowTo: new Date("2026-09-04T17:00:00.000Z"),
    });
    expect(report.documents.map((item) => item.title)).toEqual(["Jobs.xlsx", "Broken.pdf"]);
    expect(report.documents[0]?.chunkCount).toBe(4);
    expect(report.documents[0]?.indexed).toBe(true);
    expect(report.documents[1]?.outcome).toBe("failed");
    expect(report.documents[1]?.failureReason).toBe("empty content");
    expect(report.scannedSourceTypes).toEqual(["onedrive"]);
    expect(report.chunkTotal).toBe(4);
  });

  it("counts existing files modified in-window as updated knowledge", async () => {
    const env = {
      DB: mockDb([
        {
          match: /microsoft_knowledge_items/,
          rows: [
            {
              id: "ms_el_old",
              title: "Elvex Jobs.xlsx",
              source_type: "onedrive",
              knowledge_document_id: 3,
              created_at: "2026-08-30T11:09:52.000Z",
              modified_at: "2026-09-04T10:11:00.000Z",
              indexed_at: "2026-08-30T11:10:00.000Z",
              indexing_status: "indexed",
              external_id: "msod-old",
              external_item_id: "item-old",
              web_url: "https://elvex-my.sharepoint.com/personal/a/Jobs.xlsx",
              path: "/Elvex Jobs.xlsx",
              provenance_json: "{}",
            },
          ],
        },
      ]),
    } as never;
    const report = await queryKnowledgeIngestionActivity(env, {
      companyId: "co_el",
      windowFrom: new Date("2026-09-03T17:39:03.388Z"),
      windowTo: new Date("2026-09-04T17:39:03.388Z"),
    });
    expect(report.documents).toHaveLength(1);
    expect(report.documents[0]?.activityKind).toBe("updated");
    expect(report.updatedCount).toBe(1);
  });

  it("promotes ledger source_observed rows and uses email subject metadata", async () => {
    const env = {
      DB: mockDb([
        {
          match: /knowledge_ingestion_events/,
          rows: [
            {
              id: "kie_quote",
              company_id: "co_el",
              source_type: "outlook_attachments",
              event_type: "source_observed",
              status: "source_observed",
              provider_item_id: "AAMk-1",
              parent_message_id: "AAMk-1",
              filename: null,
              mailbox_address: "info@elvexpropertyservices.com",
              mime_type: null,
              size_bytes: null,
              chunk_count: null,
              skip_reason: "EL Outlook attachments are not auto-ingested into company knowledge",
              failure_code: "OUTLOOK_MCP_ATTACHMENT_TOOL_MISSING",
              discovered_at: "2026-09-04T18:41:13.276Z",
              source_modified_at: "2026-09-04T15:41:18Z",
              indexed_at: null,
              created_at: "2026-09-04T18:41:13.276Z",
              metadata_json: JSON.stringify({
                subject: "RE: Quote request - 19 Lewis Street, Pentre, CF41 7JB",
                from: "lpamaintenance@touchstoneresi.co.uk",
              }),
            },
          ],
        },
      ]),
    } as never;
    const report = await queryKnowledgeIngestionActivity(env, {
      companyId: "co_el",
      windowFrom: new Date("2026-09-03T17:39:03.388Z"),
      windowTo: new Date("2026-09-04T17:39:03.388Z"),
    });
    expect(report.discoveredCount).toBe(1);
    expect(report.indexedCount).toBe(0);
    expect(report.sourceObservedCount).toBe(1);
    expect(report.documents[0]?.title).toContain("Quote request");
    expect(report.documents[0]?.parentSubject).toContain("19 Lewis Street");
    expect(report.documents[0]?.mailbox).toBe("info@elvexpropertyservices.com");
    expect(report.sourcesQueried).toContain("knowledge_ingestion_events");
  });

  it("fails only when no knowledge store can be queried", async () => {
    const env = {
      DB: {
        prepare: vi.fn(() => {
          throw new Error("d1 down");
        }),
      },
    } as never;
    await expect(
      queryKnowledgeIngestionActivity(env, {
        companyId: "co_other",
        windowFrom: new Date("2026-09-03T17:00:00.000Z"),
        windowTo: new Date("2026-09-04T17:00:00.000Z"),
      }),
    ).rejects.toThrow("DOCUMENT_STORE_UNAVAILABLE");
  });
});
