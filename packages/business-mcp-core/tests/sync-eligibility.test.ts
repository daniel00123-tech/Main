import { describe, expect, it } from "vitest";
import { classifySyncCandidate } from "../src/connectors/sync-eligibility";

describe("classifySyncCandidate", () => {
  const allowedCandidate = {
    sourceDocumentId: "file-1",
    md5Checksum: "abc123",
    modifiedTime: "2026-01-01T10:00:00.000Z",
    allowed: true,
  };

  it("skips disallowed files", () => {
    expect(
      classifySyncCandidate(
        { ...allowedCandidate, allowed: false, skipReason: "excluded_mime" },
        null
      )
    ).toEqual({ action: "skip", skipReason: "excluded_mime" });
  });

  it("queues new files", () => {
    expect(classifySyncCandidate(allowedCandidate, null)).toEqual({
      action: "queue",
      queueReason: "new",
    });
  });

  it("skips unchanged indexed files", () => {
    expect(
      classifySyncCandidate(allowedCandidate, {
        knowledgeDocumentId: 10,
        md5Checksum: "abc123",
        modifiedTime: "2026-01-01T10:00:00.000Z",
        syncStatus: "imported",
        documentStatus: "indexed",
      })
    ).toEqual({ action: "skip" });
  });

  it("queues modified files", () => {
    expect(
      classifySyncCandidate(
        { ...allowedCandidate, md5Checksum: "changed" },
        {
          knowledgeDocumentId: 10,
          md5Checksum: "abc123",
          modifiedTime: "2026-01-01T10:00:00.000Z",
          syncStatus: "imported",
          documentStatus: "indexed",
        }
      )
    ).toEqual({ action: "queue", queueReason: "modified" });
  });

  it("queues retry when sync failed", () => {
    expect(
      classifySyncCandidate(allowedCandidate, {
        knowledgeDocumentId: null,
        md5Checksum: null,
        modifiedTime: null,
        syncStatus: "failed",
        documentStatus: null,
      })
    ).toEqual({ action: "queue", queueReason: "retry_sync" });
  });
});
