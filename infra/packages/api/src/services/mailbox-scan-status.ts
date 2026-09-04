/**
 * Mailbox scan reporting: failed scans must never render as scanned=0.
 * Only a proven successful empty list may show 0.
 */

export const MAILBOX_SCAN_STATUSES = [
  "HEALTHY",
  "DEGRADED",
  "FAILED",
  "EXCLUDED",
  "COVERAGE_GAP",
] as const;

export type MailboxScanHealth = (typeof MAILBOX_SCAN_STATUSES)[number];

export function formatMailboxScanCount(input: {
  health: MailboxScanHealth;
  messagesScanned: number | null;
  errorCode?: string | null;
}): string {
  if (input.health === "EXCLUDED") return "Excluded";
  if (input.health === "COVERAGE_GAP") return "MAILBOX COVERAGE GAP";
  if (input.health === "FAILED") {
    return input.errorCode ? `SCAN FAILED — ${input.errorCode}` : "SCAN FAILED";
  }
  if (input.messagesScanned == null) {
    return input.health === "DEGRADED" ? "SCAN DEGRADED" : "SCAN FAILED";
  }
  if (input.messagesScanned === 0) return "0 (successful empty scan)";
  return String(input.messagesScanned);
}

export function mailboxScanHealth(input: {
  excluded?: boolean;
  scanned?: boolean;
  scanFailed?: boolean;
  lastScanAt?: string | null;
  graphFailed?: boolean;
  fetchFailed?: boolean;
  messagesScanned?: number | null;
  failures?: number;
}): MailboxScanHealth {
  if (input.excluded) return "EXCLUDED";
  if (input.scanFailed) return "FAILED";
  if (!input.scanned && !input.lastScanAt) return "COVERAGE_GAP";
  if ((input.failures ?? 0) > 0 || input.fetchFailed || input.graphFailed) return "DEGRADED";
  return "HEALTHY";
}

export function isProvenEmptyScan(input: {
  listSucceeded: boolean;
  source: "graph" | "company_mcp" | "none";
  messagesScanned: number;
}): boolean {
  return input.listSucceeded && input.source === "graph" && input.messagesScanned === 0;
}
