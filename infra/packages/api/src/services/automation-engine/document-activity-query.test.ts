import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../control-plane", () => ({
  getCompanyById: vi.fn(async () => ({ id: "co_example", slug: "example", name: "Example Ltd" })),
  listMcpEnvironments: vi.fn(async () => []),
}));

import { queryDocumentActivity } from "./document-activity-query";

function mockDb(rows: Array<Record<string, unknown>>) {
  return {
    prepare: vi.fn(() => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    })),
  } as unknown as D1Database;
}

describe("document activity query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts unique Microsoft knowledge documents and Outlook attachments only", async () => {
    const env = {
      DB: mockDb([
        {
          title: "One.pdf",
          source_type: "onedrive",
          knowledge_document_id: 1,
          created_at: "2026-08-20T00:00:00.000Z",
          modified_at: "2026-08-20T00:00:00.000Z",
          external_id: "msod-1",
          external_item_id: "item-1",
          provenance_json: "{}",
        },
        {
          title: "One.pdf",
          source_type: "onedrive",
          knowledge_document_id: 1,
          created_at: "2026-08-20T00:00:00.000Z",
          modified_at: "2026-08-20T00:00:00.000Z",
          external_id: "msod-1",
          external_item_id: "item-1",
          provenance_json: "{}",
        },
        {
          title: "Mail subject",
          source_type: "outlook_shared",
          knowledge_document_id: 2,
          created_at: "2026-08-20T00:00:00.000Z",
          modified_at: "2026-08-20T00:00:00.000Z",
          external_id: "msml-1",
          external_item_id: "msg-1",
          provenance_json: JSON.stringify({ itemKind: "mail_message" }),
        },
        {
          title: "Quote.pdf",
          source_type: "outlook_shared",
          knowledge_document_id: 3,
          created_at: "2026-08-28T10:00:00.000Z",
          modified_at: "2026-08-28T09:00:00.000Z",
          external_id: "msat-1",
          external_item_id: "msg-1|att-1",
          provenance_json: JSON.stringify({ itemKind: "mail_attachment" }),
        },
      ]),
    } as never;

    const report = await queryDocumentActivity(env, "co_example", new Date("2026-08-28T11:00:00.000Z"));
    expect(report.triggeredProviderScan).toBe(false);
    expect(report.sourceCounts.find((row) => row.key === "onedrive")?.count).toBe(1);
    expect(report.sourceCounts.find((row) => row.key === "outlook_attachments")?.count).toBe(1);
    expect(report.newDocuments.map((item) => item.title)).toEqual(["Quote.pdf"]);
    expect(report.newCount).toBe(1);
    expect(report.sourcesUnavailable).toContain("mcp_knowledge_documents");
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
      queryDocumentActivity(env, "co_example", new Date("2026-08-28T11:00:00.000Z")),
    ).rejects.toThrow("DOCUMENT_STORE_UNAVAILABLE");
  });
});
