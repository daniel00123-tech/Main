import { describe, expect, it } from "vitest";
import { classifyActivityKind, timestampInWindow } from "@infra/shared";
import { recordKnowledgeIngestionEvent } from "./knowledge-ingestion-events";

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
      timestampInWindow("2026-08-18T15:23:09Z", new Date("2026-09-03T17:39:03.388Z"), new Date("2026-09-04T17:39:03.388Z")),
    ).toBe(false);
  });
});
