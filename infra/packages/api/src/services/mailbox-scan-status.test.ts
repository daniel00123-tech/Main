import { describe, expect, it } from "vitest";
import { formatMailboxScanCount, isProvenEmptyScan, mailboxScanHealth } from "./mailbox-scan-status";

describe("mailbox scan status", () => {
  it("never renders a failed scan as 0", () => {
    expect(
      formatMailboxScanCount({ health: "FAILED", messagesScanned: 0, errorCode: "MCP_EMPTY_UNPROVEN" }),
    ).toBe("SCAN FAILED — MCP_EMPTY_UNPROVEN");
    expect(formatMailboxScanCount({ health: "FAILED", messagesScanned: null, errorCode: "AADSTS7000229" })).toBe(
      "SCAN FAILED — AADSTS7000229",
    );
  });

  it("renders a proven empty Graph list as successful zero", () => {
    expect(isProvenEmptyScan({ listSucceeded: true, source: "graph", messagesScanned: 0 })).toBe(true);
    expect(isProvenEmptyScan({ listSucceeded: true, source: "company_mcp", messagesScanned: 0 })).toBe(false);
    expect(formatMailboxScanCount({ health: "HEALTHY", messagesScanned: 0 })).toBe("0 (successful empty scan)");
  });

  it("marks an included mailbox with no scan as a coverage gap", () => {
    expect(mailboxScanHealth({ excluded: false, scanned: false, lastScanAt: null })).toBe("COVERAGE_GAP");
    expect(formatMailboxScanCount({ health: "COVERAGE_GAP", messagesScanned: null })).toBe("MAILBOX COVERAGE GAP");
  });
});
