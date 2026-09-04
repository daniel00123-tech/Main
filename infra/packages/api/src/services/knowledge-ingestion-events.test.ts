import { describe, expect, it } from "vitest";
import { classifyActivityKind, timestampInWindow } from "@infra/shared";
import { knowledgeIngestionEventInWindow, recordKnowledgeIngestionEvent } from "./knowledge-ingestion-events";

describe("knowledge ingestion ledger", () => {
  it("records a tenant-scoped event without leaking other companies", async () => {
    const inserts: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        run: async () => ({ success: true }),
        bind: (...args: unknown[]) => {
          if (sql.includes("INSERT INTO knowledge_ingestion_events")) inserts.push(args);
          return { run: async () => ({ success: true }), all: async () => ({ results: [] }), first: async () => null };
        },
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    } as unknown as D1Database;

    const id = await recordKnowledgeIngestionEvent(db, {
      companyId: "co_el",
      sourceType: "outlook_attachments",
      eventType: "source_observed",
      filename: "quote.pdf",
      mailboxAddress: "info@elvexpropertyservices.com",
    });
    expect(id.startsWith("kie_")).toBe(true);
    expect(inserts[0]?.[1]).toBe("co_el");
    expect(inserts[0]?.[2]).toBe("outlook_attachments");
  });

  it("upserts the same provider item instead of duplicating ledger rows", async () => {
    const updates: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        run: async () => ({ success: true }),
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes("UPDATE knowledge_ingestion_events")) updates.push(args);
            return { success: true };
          },
          all: async () => ({ results: [] }),
          first: async () => (sql.includes("SELECT id FROM knowledge_ingestion_events") ? { id: "kie_existing" } : null),
        }),
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    } as unknown as D1Database;

    const id = await recordKnowledgeIngestionEvent(db, {
      companyId: "co_el",
      sourceType: "outlook_attachments",
      eventType: "source_observed",
      providerItemId: "AAMk-1",
      filename: "Attachment on: Quote request",
    });
    expect(id).toBe("kie_existing");
    expect(updates).toHaveLength(1);
  });

  it("classifies updated files when created_at is older than the window", () => {
    expect(
      classifyActivityKind({
        createdAt: "2026-08-18T15:23:09Z",
        modifiedAt: "2026-09-04T10:00:00.000Z",
        windowStart: new Date("2026-09-03T17:39:03.388Z"),
        windowEnd: new Date("2026-09-04T17:39:03.388Z"),
        indexed: true,
      }),
    ).toBe("updated");
    expect(
      classifyActivityKind({
        createdAt: "2026-09-04T18:41:13.276Z",
        modifiedAt: "2026-09-04T15:41:18Z",
        windowStart: new Date("2026-09-03T17:39:03.388Z"),
        windowEnd: new Date("2026-09-04T17:39:03.388Z"),
        indexed: false,
        outcome: "failed",
      }),
    ).toBe("source_observed");
    expect(
      timestampInWindow("2026-08-18T15:23:09Z", new Date("2026-09-03T17:39:03.388Z"), new Date("2026-09-04T17:39:03.388Z")),
    ).toBe(false);
  });

  it("windows source_observed rows on source time, not ledger write time", () => {
    const row = {
      source_modified_at: "2026-09-04T15:41:18Z",
      discovered_at: "2026-09-04T18:41:13.276Z",
      created_at: "2026-09-04T18:41:13.276Z",
      indexed_at: null,
    };
    expect(
      knowledgeIngestionEventInWindow(row, "2026-09-03T17:39:03.388Z", "2026-09-04T17:39:03.388Z"),
    ).toBe(true);
    expect(
      knowledgeIngestionEventInWindow(row, "2026-09-04T17:39:03.388Z", "2026-09-05T07:00:00.000Z"),
    ).toBe(false);
  });
});
