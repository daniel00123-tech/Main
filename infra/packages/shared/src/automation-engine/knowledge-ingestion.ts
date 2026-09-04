/** Knowledge-ingestion activity window and classification — no provider scans. */

import { DOCUMENT_ACTIVITY_WINDOW_MS, isOutlookAttachmentItem, parseMaybeDate } from "./document-activity";

export const KNOWLEDGE_INGESTION_EMAIL_LIST_LIMIT = 25;
export const KNOWLEDGE_INGESTION_INITIAL_LOOKBACK_MS = DOCUMENT_ACTIVITY_WINDOW_MS;

export type KnowledgeIngestionSourceKey =
  | "onedrive"
  | "sharepoint"
  | "outlook_attachments"
  | "other_microsoft365";

export type KnowledgeIngestionOutcome =
  | "indexed"
  | "extracted"
  | "discovered"
  | "duplicate"
  | "skipped"
  | "failed";

export type KnowledgeIngestionSourceCount = {
  key: KnowledgeIngestionSourceKey;
  label: string;
  count: number;
};

export type KnowledgeIngestionDocument = {
  id: string;
  title: string;
  sourceKey: KnowledgeIngestionSourceKey;
  sourceLabel: string;
  provider: string;
  location: string | null;
  mailbox: string | null;
  parentSubject: string | null;
  sender: string | null;
  discoveredAt: string | null;
  modifiedAt: string | null;
  discovered: boolean;
  extracted: boolean;
  indexed: boolean;
  chunkCount: number | null;
  outcome: KnowledgeIngestionOutcome;
  failureReason: string | null;
  url: string | null;
};

const SOURCE_LABELS: Record<KnowledgeIngestionSourceKey, string> = {
  onedrive: "OneDrive",
  sharepoint: "SharePoint",
  outlook_attachments: "Email attachments",
  other_microsoft365: "Other Microsoft 365",
};

export function knowledgeIngestionSourceLabel(key: KnowledgeIngestionSourceKey): string {
  return SOURCE_LABELS[key];
}

export function resolveKnowledgeIngestionWindow(
  now: Date,
  lastSuccessful?: { windowTo?: string | null; completedAt?: string | null } | null,
): { from: Date; to: Date; initialLookback: boolean } {
  const to = now;
  const previous = parseMaybeDate(lastSuccessful?.windowTo) ?? parseMaybeDate(lastSuccessful?.completedAt);
  if (previous && previous.getTime() < to.getTime()) {
    return { from: previous, to, initialLookback: false };
  }
  return { from: new Date(to.getTime() - KNOWLEDGE_INGESTION_INITIAL_LOOKBACK_MS), to, initialLookback: true };
}

export function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function classifyKnowledgeIngestionSource(input: {
  sourceType?: string | null;
  webUrl?: string | null;
  externalId?: string | null;
  externalItemId?: string | null;
  itemKind?: string | null;
}): KnowledgeIngestionSourceKey | null {
  const sourceType = (input.sourceType ?? "").trim().toLowerCase();
  if (
    sourceType === "outlook_shared" ||
    sourceType === "outlook" ||
    sourceType === "email" ||
    sourceType === "outlook_attachments"
  ) {
    if (
      isOutlookAttachmentItem({
        externalId: input.externalId,
        externalItemId: input.externalItemId,
        itemKind: input.itemKind,
      }) ||
      sourceType === "outlook_attachments" ||
      input.itemKind === "mail_attachment"
    ) {
      return "outlook_attachments";
    }
    return null;
  }
  const url = input.webUrl ?? "";
  if (sourceType === "onedrive" || /onedrive\.live\.com|1drv\.ms|[-.]my\.sharepoint\.com|\/personal\//i.test(url)) {
    return "onedrive";
  }
  if (sourceType === "sharepoint") return "sharepoint";
  if (sourceType === "microsoft365" || sourceType === "microsoft" || sourceType === "m365") {
    return "other_microsoft365";
  }
  if (sourceType) return "other_microsoft365";
  return null;
}

export function classifyKnowledgeIngestionOutcome(input: {
  status?: string | null;
  indexingStatus?: string | null;
  extracted: boolean;
  indexed: boolean;
  knowledgeDocumentId?: number | null;
}): KnowledgeIngestionOutcome {
  const status = (input.status ?? "").trim().toLowerCase();
  const indexing = (input.indexingStatus ?? "").trim().toLowerCase();
  if (indexing === "skipped" || status === "duplicate") return "duplicate";
  if (status === "excluded_protected" || status === "excluded" || status === "skipped") {
    return "skipped";
  }
  if (indexing === "failed" || indexing === "unsupported" || status === "failed" || status === "error") {
    return "failed";
  }
  if (input.indexed || indexing === "indexed" || (input.extracted && status === "catalogue")) {
    return "indexed";
  }
  if (input.extracted) return "extracted";
  if (status === "skipped" || status === "excluded") return "skipped";
  return "discovered";
}

export function safeIngestionFailureReason(input: {
  status?: string | null;
  indexingStatus?: string | null;
  extracted?: boolean;
  outcome?: KnowledgeIngestionOutcome;
}): string | null {
  const status = (input.status ?? "").trim().toLowerCase();
  const indexing = (input.indexingStatus ?? "").trim().toLowerCase();
  if (input.outcome === "duplicate" || indexing === "skipped" || status === "duplicate") {
    return "duplicate";
  }
  if (status === "excluded_protected" || status === "excluded" || status === "skipped") {
    return "skipped (protected or excluded)";
  }
  if (indexing === "unsupported" || status === "unsupported") return "unsupported format";
  if (indexing === "failed" || status === "failed" || status === "error") {
    return input.extracted === false ? "empty content" : "indexing failure";
  }
  if (input.outcome === "failed" && input.extracted === false) return "empty content";
  if (input.outcome === "failed") return "ingestion failed";
  return null;
}

export function timestampInWindow(
  value: string | null | undefined,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  const date = parseMaybeDate(value);
  if (!date) return false;
  return date.getTime() >= windowStart.getTime() && date.getTime() <= windowEnd.getTime();
}

export function capKnowledgeList<T>(items: T[], limit = KNOWLEDGE_INGESTION_EMAIL_LIST_LIMIT): {
  items: T[];
  omitted: number;
} {
  if (items.length <= limit) return { items, omitted: 0 };
  return { items: items.slice(0, limit), omitted: items.length - limit };
}

export function groupKnowledgeSourceCounts(
  documents: KnowledgeIngestionDocument[],
): KnowledgeIngestionSourceCount[] {
  const counts = new Map<KnowledgeIngestionSourceKey, number>();
  for (const doc of documents) {
    counts.set(doc.sourceKey, (counts.get(doc.sourceKey) ?? 0) + 1);
  }
  return (["onedrive", "sharepoint", "outlook_attachments", "other_microsoft365"] as const)
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => ({
      key,
      label: knowledgeIngestionSourceLabel(key),
      count: counts.get(key) ?? 0,
    }));
}

export function summariseKnowledgeIngestion(documents: KnowledgeIngestionDocument[]) {
  let indexedCount = 0;
  let chunkTotal = 0;
  let chunksKnown = false;
  let duplicateCount = 0;
  let failedCount = 0;
  for (const doc of documents) {
    if (doc.indexed || doc.outcome === "indexed") indexedCount += 1;
    if (typeof doc.chunkCount === "number" && Number.isFinite(doc.chunkCount)) {
      chunkTotal += doc.chunkCount;
      chunksKnown = true;
    }
    if (doc.outcome === "duplicate" || doc.outcome === "skipped") duplicateCount += 1;
    if (doc.outcome === "failed") failedCount += 1;
  }
  return {
    discoveredCount: documents.length,
    indexedCount,
    chunkTotal: chunksKnown ? chunkTotal : null,
    duplicateCount,
    failedCount,
  };
}
