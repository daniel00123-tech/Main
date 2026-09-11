export type SyncQueueReason = "new" | "modified" | "retry_sync" | "retry_index";

export interface SyncExistingState {
  knowledgeDocumentId: number | null;
  md5Checksum: string | null;
  modifiedTime: string | null;
  syncStatus: string;
  documentStatus: string | null;
}

export interface SyncCandidate {
  sourceDocumentId: string;
  md5Checksum?: string | null;
  modifiedTime?: string | null;
  allowed: boolean;
  skipReason?: string;
}

export interface SyncDecision {
  action: "queue" | "skip";
  queueReason?: SyncQueueReason;
  skipReason?: string;
}

export function classifySyncCandidate(
  candidate: SyncCandidate,
  existing: SyncExistingState | null
): SyncDecision {
  if (!candidate.allowed) {
    return { action: "skip", skipReason: candidate.skipReason ?? "not_allowed" };
  }

  if (existing?.syncStatus === "failed") {
    return { action: "queue", queueReason: "retry_sync" };
  }

  if (
    existing?.knowledgeDocumentId &&
    existing.documentStatus &&
    existing.documentStatus !== "indexed"
  ) {
    return { action: "queue", queueReason: "retry_index" };
  }

  if (!existing?.knowledgeDocumentId) {
    return { action: "queue", queueReason: "new" };
  }

  if (
    candidate.md5Checksum &&
    existing.md5Checksum &&
    existing.md5Checksum === candidate.md5Checksum &&
    existing.documentStatus === "indexed"
  ) {
    return { action: "skip" };
  }

  if (
    !candidate.md5Checksum &&
    candidate.modifiedTime &&
    existing.modifiedTime === candidate.modifiedTime &&
    existing.documentStatus === "indexed"
  ) {
    return { action: "skip" };
  }

  if (candidate.md5Checksum && existing.md5Checksum !== candidate.md5Checksum) {
    return { action: "queue", queueReason: "modified" };
  }

  if (candidate.modifiedTime && existing.modifiedTime !== candidate.modifiedTime) {
    return { action: "queue", queueReason: "modified" };
  }

  if (existing.knowledgeDocumentId && existing.documentStatus === "indexed") {
    return { action: "skip" };
  }

  return { action: "queue", queueReason: "new" };
}
