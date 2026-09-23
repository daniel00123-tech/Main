import { describe, expect, it } from "vitest";
import { classifyDriveFileForSync } from "../src/google-drive-sync";
import type { GoogleDriveListedFile } from "../src/google-drive-client";

function makeFile(overrides: Partial<GoogleDriveListedFile> = {}): GoogleDriveListedFile {
  return {
    id: "file-1",
    name: "Example.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    modifiedTime: "2026-01-01T10:00:00.000Z",
    md5Checksum: "abc123",
    filterDecision: {
      allowed: true,
      reason: "allowed_mime_type",
    },
    ...overrides,
  };
}

describe("classifyDriveFileForSync", () => {
  it("skips disallowed files", () => {
    const decision = classifyDriveFileForSync(
      makeFile({
        filterDecision: { allowed: false, reason: "excluded_mime_prefix" },
      }),
      null
    );
    expect(decision).toEqual({
      action: "skip",
      skipReason: "excluded_mime_prefix",
    });
  });

  it("queues new files", () => {
    const decision = classifyDriveFileForSync(makeFile(), null);
    expect(decision).toEqual({ action: "queue", queueReason: "new" });
  });

  it("skips unchanged files with matching md5 and indexed status", () => {
    const decision = classifyDriveFileForSync(makeFile(), {
      knowledge_document_id: 10,
      md5_checksum: "abc123",
      modified_time: "2026-01-01T10:00:00.000Z",
      sync_status: "imported",
      document_status: "indexed",
    });
    expect(decision).toEqual({ action: "skip" });
  });

  it("queues modified files when md5 changes", () => {
    const decision = classifyDriveFileForSync(makeFile({ md5Checksum: "changed" }), {
      knowledge_document_id: 10,
      md5_checksum: "abc123",
      modified_time: "2026-01-01T10:00:00.000Z",
      sync_status: "imported",
      document_status: "indexed",
    });
    expect(decision).toEqual({ action: "queue", queueReason: "modified" });
  });

  it("queues retry when sync previously failed", () => {
    const decision = classifyDriveFileForSync(makeFile(), {
      knowledge_document_id: null,
      md5_checksum: null,
      modified_time: null,
      sync_status: "failed",
      document_status: null,
    });
    expect(decision).toEqual({ action: "queue", queueReason: "retry_sync" });
  });

  it("queues retry when index is pending", () => {
    const decision = classifyDriveFileForSync(makeFile(), {
      knowledge_document_id: 10,
      md5_checksum: "abc123",
      modified_time: "2026-01-01T10:00:00.000Z",
      sync_status: "imported",
      document_status: "pending",
    });
    expect(decision).toEqual({ action: "queue", queueReason: "retry_index" });
  });

  it("skips Google Docs without md5 when modifiedTime is unchanged", () => {
    const decision = classifyDriveFileForSync(
      makeFile({
        md5Checksum: undefined,
        mimeType: "application/vnd.google-apps.document",
      }),
      {
        knowledge_document_id: 10,
        md5_checksum: null,
        modified_time: "2026-01-01T10:00:00.000Z",
        sync_status: "imported",
        document_status: "indexed",
      }
    );
    expect(decision).toEqual({ action: "skip" });
  });
});
