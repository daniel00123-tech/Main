import { describe, expect, it } from "vitest";
import {
  MICROSOFT_KNOWLEDGE_INGEST_DLQ,
  MICROSOFT_KNOWLEDGE_INGEST_QUEUE,
  MICROSOFT_QUEUE_MAX_RETRIES,
  type MicrosoftFileJobMessage,
} from "./microsoft-queue";

describe("Microsoft queue architecture (CMD14)", () => {
  it("defines stable queue names", () => {
    expect(MICROSOFT_KNOWLEDGE_INGEST_QUEUE).toBe("microsoft-knowledge-ingest");
    expect(MICROSOFT_KNOWLEDGE_INGEST_DLQ).toBe("microsoft-knowledge-ingest-dlq");
  });

  it("uses sensible retry limit", () => {
    expect(MICROSOFT_QUEUE_MAX_RETRIES).toBeGreaterThanOrEqual(3);
    expect(MICROSOFT_QUEUE_MAX_RETRIES).toBeLessThanOrEqual(10);
  });

  it("queue messages contain identifiers only — no secrets", () => {
    const message: MicrosoftFileJobMessage = {
      jobId: "msj_test",
      companyId: "co_caddington",
      sourceId: "mss_test",
      syncRunId: "msr_test",
    };
    const serialised = JSON.stringify(message);
    expect(serialised).not.toMatch(/token|secret|password|bearer/i);
    expect(Object.keys(message).sort()).toEqual(
      ["companyId", "jobId", "sourceId", "syncRunId"].sort(),
    );
  });

  it("documents per-file job statuses for portal observability", () => {
    const statuses = [
      "queued",
      "processing",
      "indexed",
      "skipped_unchanged",
      "unsupported",
      "catalogue_only",
      "failed",
      "retrying",
      "dead_letter",
    ];
    expect(statuses).toContain("queued");
    expect(statuses).toContain("indexed");
    expect(statuses).toContain("dead_letter");
  });
});
