import type { BusinessDocumentFormat } from "./document-segments";

export interface DocumentSearchMetadata {
  originalFilename?: string;
  sourceFormat?: string;
  company?: string;
  project?: string;
  category?: string;
  source?: string;
  documentDate?: string;
  mimeType?: string;
}

export interface ChunkSearchRecord {
  chunkId: number;
  documentId: number;
  chunkIndex: number;
  content: string;
  title: string;
  externalId: string;
  filename: string;
  heading: string;
  section: string;
  project: string;
  company: string;
  category: string;
  documentType: string;
  source: string;
  documentDate: string;
  page?: number;
  sheet?: string;
  slide?: number;
  chunkNumber?: number;
}

export function parseDocumentMetadataJson(
  raw: string | null | undefined
): DocumentSearchMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as DocumentSearchMetadata;
  } catch {
    return {};
  }
}

export function filenameFromR2Key(r2Key: string): string {
  const parts = r2Key.split("/");
  return parts[parts.length - 1] || r2Key;
}

export function documentTypeFromMime(
  mimeType: string | null | undefined,
  sourceFormat?: string
): string {
  if (sourceFormat) return sourceFormat;
  if (!mimeType) return "unknown";
  const lower = mimeType.toLowerCase();
  if (lower.includes("pdf")) return "pdf";
  if (lower.includes("word")) return "docx";
  if (lower.includes("spreadsheet") || lower.includes("excel")) return "xlsx";
  if (lower.includes("presentation")) return "pptx";
  if (lower.startsWith("image/")) return "image";
  if (lower.includes("csv")) return "csv";
  if (lower.includes("markdown")) return "md";
  if (lower.startsWith("text/")) return "txt";
  return "unknown";
}

export function buildChunkSearchRecord(
  chunk: {
    id: number;
    document_id: number;
    chunk_index: number;
    content: string;
    metadata?: string | null;
  },
  document: {
    external_id: string;
    title: string;
    r2_key: string;
    mime_type: string | null;
    metadata?: string | null;
  }
): ChunkSearchRecord {
  const docMeta = parseDocumentMetadataJson(document.metadata);
  let chunkMeta: Record<string, unknown> = {};
  if (chunk.metadata) {
    try {
      chunkMeta = JSON.parse(chunk.metadata) as Record<string, unknown>;
    } catch {
      chunkMeta = {};
    }
  }

  const filename =
    docMeta.originalFilename ?? filenameFromR2Key(document.r2_key);
  const documentType =
    docMeta.sourceFormat ??
    documentTypeFromMime(document.mime_type, docMeta.sourceFormat);

  return {
    chunkId: chunk.id,
    documentId: chunk.document_id,
    chunkIndex: chunk.chunk_index,
    content: chunk.content,
    title: document.title,
    externalId: document.external_id,
    filename,
    heading: typeof chunkMeta.heading === "string" ? chunkMeta.heading : "",
    section: typeof chunkMeta.section === "string" ? chunkMeta.section : "",
    project: docMeta.project ?? "",
    company: docMeta.company ?? "",
    category: docMeta.category ?? "",
    documentType,
    source: docMeta.source ?? "",
    documentDate: docMeta.documentDate ?? "",
    page: typeof chunkMeta.page === "number" ? chunkMeta.page : undefined,
    sheet: typeof chunkMeta.sheet === "string" ? chunkMeta.sheet : undefined,
    slide: typeof chunkMeta.slide === "number" ? chunkMeta.slide : undefined,
    chunkNumber:
      typeof chunkMeta.chunkNumber === "number"
        ? chunkMeta.chunkNumber
        : chunk.chunk_index,
  };
}

export function buildUploadMetadata(
  fileName: string,
  fields: {
    company?: string;
    project?: string;
    category?: string;
    source?: string;
    documentDate?: string;
  }
): Record<string, string> {
  const metadata: Record<string, string> = {
    originalFilename: fileName,
  };
  if (fields.company) metadata.company = fields.company;
  if (fields.project) metadata.project = fields.project;
  if (fields.category) metadata.category = fields.category;
  if (fields.source) metadata.source = fields.source;
  if (fields.documentDate) metadata.documentDate = fields.documentDate;
  return metadata;
}

export function vectorMetadataFromRecord(
  record: ChunkSearchRecord
): Record<string, string> {
  const meta: Record<string, string> = {
    document_id: String(record.documentId),
    chunk_id: String(record.chunkId),
    chunk_index: String(record.chunkIndex),
    external_id: record.externalId,
    title: record.title,
    snippet: record.content.slice(0, 280),
    filename: record.filename,
    document_type: record.documentType,
  };
  if (record.heading) meta.heading = record.heading;
  if (record.section) meta.section = record.section;
  if (record.project) meta.project = record.project;
  if (record.company) meta.company = record.company;
  if (record.category) meta.category = record.category;
  if (record.source) meta.source = record.source;
  if (record.documentDate) meta.document_date = record.documentDate;
  if (record.page != null) meta.page = String(record.page);
  if (record.sheet) meta.sheet = record.sheet;
  if (record.slide != null) meta.slide = String(record.slide);
  if (record.chunkNumber != null) meta.chunk_number = String(record.chunkNumber);
  return meta;
}

export interface KnowledgeSearchFilters {
  company?: string;
  project?: string;
  category?: string;
  document_type?: string;
  document_date?: string;
  source?: string;
  filename?: string;
  title?: string;
}

export function documentMatchesFilters(
  document: {
    title: string;
    metadata?: string | null;
    mime_type?: string | null;
    r2_key?: string;
  },
  filters: KnowledgeSearchFilters
): boolean {
  const meta = parseDocumentMetadataJson(document.metadata);
  const filename = meta.originalFilename ?? filenameFromR2Key(document.r2_key ?? "");
  const documentType = documentTypeFromMime(
    document.mime_type,
    meta.sourceFormat
  );

  if (filters.company && !matchesLoose(meta.company, filters.company)) {
    return false;
  }
  if (filters.project && !matchesLoose(meta.project, filters.project)) {
    return false;
  }
  if (filters.category && !matchesLoose(meta.category, filters.category)) {
    return false;
  }
  if (
    filters.document_type &&
    !matchesLoose(documentType, filters.document_type)
  ) {
    return false;
  }
  if (
    filters.document_date &&
    !matchesLoose(meta.documentDate, filters.document_date)
  ) {
    return false;
  }
  if (filters.source && !matchesLoose(meta.source, filters.source)) {
    return false;
  }
  if (filters.filename && !matchesLoose(filename, filters.filename)) {
    return false;
  }
  if (filters.title && !matchesLoose(document.title, filters.title)) {
    return false;
  }
  return true;
}

function matchesLoose(value: string | undefined, filter: string): boolean {
  if (!filter) return true;
  const left = (value ?? "").toLowerCase();
  const right = filter.toLowerCase();
  return left.includes(right) || right.includes(left);
}
