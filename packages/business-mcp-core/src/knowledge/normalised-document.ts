import type { DocumentSearchMetadata, SearchProvenance } from "./metadata";

export interface NormalisedDocument {
  source: string;
  sourceDocumentId: string;
  externalId: string;
  title: string;
  filename: string;
  mimeType: string;
  modifiedAt?: string;
  effectiveDate?: string;
  version?: string;
  isCurrent?: boolean;
  company?: string;
  bytes: ArrayBuffer;
  metadata: DocumentSearchMetadata & Record<string, unknown>;
  provenance: Partial<SearchProvenance>;
}

export interface SourceDocumentCandidate {
  sourceDocumentId: string;
  title: string;
  filename: string;
  mimeType: string;
  modifiedAt?: string | null;
  md5Checksum?: string | null;
  allowed: boolean;
  skipReason?: string;
}

export function buildNormalisedDocument(input: {
  source: string;
  sourceDocumentId: string;
  externalId: string;
  title: string;
  filename: string;
  mimeType: string;
  bytes: ArrayBuffer;
  metadata?: DocumentSearchMetadata & Record<string, unknown>;
  modifiedAt?: string;
  effectiveDate?: string;
  version?: string;
  isCurrent?: boolean;
  company?: string;
}): NormalisedDocument {
  return {
    source: input.source,
    sourceDocumentId: input.sourceDocumentId,
    externalId: input.externalId,
    title: input.title,
    filename: input.filename,
    mimeType: input.mimeType,
    modifiedAt: input.modifiedAt,
    effectiveDate: input.effectiveDate,
    version: input.version,
    isCurrent: input.isCurrent,
    company: input.company,
    bytes: input.bytes,
    metadata: input.metadata ?? {},
    provenance: {
      source: input.source,
      title: input.title,
      filename: input.filename,
      company: input.company,
      version: input.version,
      effectiveDate: input.effectiveDate,
      isCurrent: input.isCurrent,
    },
  };
}
