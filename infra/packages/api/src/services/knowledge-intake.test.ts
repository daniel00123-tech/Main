import { describe, expect, it } from "vitest";
import {
  collisionSafeIntakeFilename,
  isKnowledgeIntakePath,
  knowledgeIntakeFolderSegments,
  mailboxFolderSegment,
} from "./knowledge-intake";

describe("knowledge intake helpers", () => {
  it("builds a collision-safe filename from the original name and hash", () => {
    expect(collisionSafeIntakeFilename("Remittance Advice.pdf", "abc123def456", "att-1")).toBe(
      "Remittance Advice__abc123def4.pdf",
    );
  });

  it("keeps different content hashes distinct for the same filename", () => {
    const a = collisionSafeIntakeFilename("receipt.pdf", "aaaa", "1");
    const b = collisionSafeIntakeFilename("receipt.pdf", "bbbb", "2");
    expect(a).not.toBe(b);
  });

  it("identifies the landing-zone path so catalogue sync can skip stored copies", () => {
    expect(isKnowledgeIntakePath("INFRA Knowledge Intake/Email Attachments/finance/2026/09/file.pdf")).toBe(true);
    expect(isKnowledgeIntakePath("Shared Documents/Quotes/file.pdf")).toBe(false);
  });

  it("uses the mailbox local-part as the folder name", () => {
    expect(mailboxFolderSegment("finance@elvexpropertyservices.com")).toBe("finance");
    expect(mailboxFolderSegment("michael@elvexpropertyservices.com")).toBe("michael");
  });

  it("quarantines unsafe binaries under _quarantine instead of the mailbox tree", () => {
    const received = new Date("2026-09-04T13:41:08.000Z");
    expect(knowledgeIntakeFolderSegments("finance@elvexpropertyservices.com", received)).toEqual([
      "Email Attachments",
      "finance",
      "2026",
      "09",
    ]);
    expect(knowledgeIntakeFolderSegments("finance@elvexpropertyservices.com", received, true)).toEqual([
      "Email Attachments",
      "_quarantine",
      "finance",
      "2026",
      "09",
    ]);
    expect(isKnowledgeIntakePath("INFRA Knowledge Intake/Email Attachments/_quarantine/finance/2026/09/setup.exe")).toBe(
      true,
    );
  });
});
