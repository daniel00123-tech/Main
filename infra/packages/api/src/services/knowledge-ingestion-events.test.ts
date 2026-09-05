import { describe, expect, it } from "vitest";
import { classifyActivityKind, timestampInWindow } from "@infra/shared";
import {
  classifyMailboxAttachmentFailure,
  isTerminalAttachmentFailure,
  knowledgeIngestionEventInWindow,
  mailboxFailureLedgerMetadata,
  recordKnowledgeIngestionEvent,
} from "./knowledge-ingestion-events";

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

  it("includes items worked in the reporting window even if the source file is older", () => {
    const row = {
      source_modified_at: "2026-09-01T15:41:18Z",
      discovered_at: "2026-09-04T21:42:53.504Z",
      created_at: "2026-09-04T21:42:53.504Z",
      indexed_at: null,
      stored_at: "2026-09-04T21:42:54.676Z",
    };
    expect(
      knowledgeIngestionEventInWindow(row, "2026-09-04T21:10:00.000Z", "2026-09-04T21:53:00.000Z"),
    ).toBe(true);
    expect(
      knowledgeIngestionEventInWindow(row, "2026-09-03T17:39:03.388Z", "2026-09-04T17:39:03.388Z"),
    ).toBe(false);
  });

  it("classifies mailbox failure retry semantics without infinite retries", () => {
    expect(classifyMailboxAttachmentFailure("FETCH_TRANSIENT")).toEqual({
      retryable: true,
      terminal: false,
      eventType: "failed",
    });
    expect(classifyMailboxAttachmentFailure("UNSUPPORTED_MIME")).toEqual({
      retryable: false,
      terminal: true,
      eventType: "skipped",
    });
    expect(classifyMailboxAttachmentFailure("CORRUPT_WORKBOOK")).toEqual({
      retryable: false,
      terminal: true,
      eventType: "failed",
    });
    expect(classifyMailboxAttachmentFailure("KNOWLEDGE_EXTRACT_EMPTY")).toEqual({
      retryable: true,
      terminal: false,
      eventType: "failed",
    });
    expect(classifyMailboxAttachmentFailure("EMPTY_WORKBOOK")).toEqual({
      retryable: false,
      terminal: true,
      eventType: "skipped",
    });
    expect(classifyMailboxAttachmentFailure("RETRIEVAL_UNVERIFIED")).toMatchObject({ retryable: true, eventType: "failed" });
    const ledger = mailboxFailureLedgerMetadata({
      company: "co_el",
      mailbox: "michael@elvexpropertyservices.com",
      messageId: "AAMk-1",
      attachmentId: "AAMk-att",
      filename: "quote.pdf",
      stage: "FETCH",
      errorClass: "FETCH_FAILED",
      retryable: true,
      attemptCount: 1,
    });
    expect(ledger).toMatchObject({
      company: "co_el",
      mailbox: "michael@elvexpropertyservices.com",
      messageId: "AAMk-1",
      attachmentId: "AAMk-att",
      stage: "FETCH",
      retryable: true,
    });
    expect(ledger.attachmentId).not.toBeFalsy();
  });

  it("marks confirmed-empty and unsupported types as terminal so they are not retried forever", () => {
    expect(isTerminalAttachmentFailure("KNOWLEDGE_EXTRACT_EMPTY")).toBe(false);
    expect(isTerminalAttachmentFailure("EXTRACT_EMPTY_TERMINAL")).toBe(true);
    expect(isTerminalAttachmentFailure("UNSUPPORTED_TYPE")).toBe(true);
    expect(isTerminalAttachmentFailure("EMPTY_WORKBOOK")).toBe(true);
    expect(isTerminalAttachmentFailure("KNOWLEDGE_UPLOAD_FAILED")).toBe(false);
    expect(isTerminalAttachmentFailure("FETCH_TRANSIENT")).toBe(false);
  });
});
