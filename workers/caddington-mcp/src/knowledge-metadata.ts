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
  department?: string;
  property?: string;
  person?: string;
  customer?: string;
  supplier?: string;
  topic?: string;
  version?: string;
  effectiveDate?: string;
  expiryDate?: string;
  supersedesDocumentId?: string;
  isCurrent?: boolean | string;
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
  topic: string;
  department: string;
  property: string;
  person: string;
  customer: string;
  supplier: string;
  documentType: string;
  source: string;
  documentDate: string;
  version?: string;
  effectiveDate?: string;
  expiryDate?: string;
  supersedesDocumentId?: string;
  isCurrent?: boolean;
  page?: number;
  sheet?: string;
  slide?: number;
  chunkNumber?: number;
}

export interface SearchProvenance {
  documentId: number;
  externalId: string;
  title: string;
  filename: string;
  documentType: string;
  page?: number;
  sheet?: string;
  slide?: number;
  section?: string;
  heading?: string;
  chunkNumber: number;
  documentDate?: string;
  company?: string;
  project?: string;
  category?: string;
  topic?: string;
  department?: string;
  property?: string;
  source?: string;
  version?: string;
  effectiveDate?: string;
  expiryDate?: string;
  isCurrent?: boolean;
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

function parseIsCurrent(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
  }
  return undefined;
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
    topic: docMeta.topic ?? "",
    department: docMeta.department ?? "",
    property: docMeta.property ?? "",
    person: docMeta.person ?? "",
    customer: docMeta.customer ?? "",
    supplier: docMeta.supplier ?? "",
    documentType,
    source: docMeta.source ?? "",
    documentDate: docMeta.documentDate ?? "",
    version: docMeta.version,
    effectiveDate: docMeta.effectiveDate,
    expiryDate: docMeta.expiryDate,
    supersedesDocumentId: docMeta.supersedesDocumentId,
    isCurrent: parseIsCurrent(docMeta.isCurrent),
    page: typeof chunkMeta.page === "number" ? chunkMeta.page : undefined,
    sheet: typeof chunkMeta.sheet === "string" ? chunkMeta.sheet : undefined,
    slide: typeof chunkMeta.slide === "number" ? chunkMeta.slide : undefined,
    chunkNumber:
      typeof chunkMeta.chunkNumber === "number"
        ? chunkMeta.chunkNumber
        : chunk.chunk_index,
  };
}

export function provenanceFromRecord(record: ChunkSearchRecord): SearchProvenance {
  return {
    documentId: record.documentId,
    externalId: record.externalId,
    title: record.title,
    filename: record.filename,
    documentType: record.documentType,
    page: record.page,
    sheet: record.sheet,
    slide: record.slide,
    section: record.section || undefined,
    heading: record.heading || undefined,
    chunkNumber: record.chunkNumber ?? record.chunkIndex,
    documentDate: record.documentDate || undefined,
    company: record.company || undefined,
    project: record.project || undefined,
    category: record.category || undefined,
    topic: record.topic || undefined,
    department: record.department || undefined,
    property: record.property || undefined,
    source: record.source || undefined,
    version: record.version,
    effectiveDate: record.effectiveDate,
    expiryDate: record.expiryDate,
    isCurrent: record.isCurrent,
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
    department?: string;
    property?: string;
    person?: string;
    customer?: string;
    supplier?: string;
    topic?: string;
    version?: string;
    effectiveDate?: string;
    expiryDate?: string;
    supersedesDocumentId?: string;
    isCurrent?: string;
  }
): Record<string, string | boolean> {
  const metadata: Record<string, string | boolean> = {
    originalFilename: fileName,
  };
  if (fields.company) metadata.company = fields.company;
  if (fields.project) metadata.project = fields.project;
  if (fields.category) metadata.category = fields.category;
  if (fields.source) metadata.source = fields.source;
  if (fields.documentDate) metadata.documentDate = fields.documentDate;
  if (fields.department) metadata.department = fields.department;
  if (fields.property) metadata.property = fields.property;
  if (fields.person) metadata.person = fields.person;
  if (fields.customer) metadata.customer = fields.customer;
  if (fields.supplier) metadata.supplier = fields.supplier;
  if (fields.topic) metadata.topic = fields.topic;
  if (fields.version) metadata.version = fields.version;
  if (fields.effectiveDate) metadata.effectiveDate = fields.effectiveDate;
  if (fields.expiryDate) metadata.expiryDate = fields.expiryDate;
  if (fields.supersedesDocumentId) {
    metadata.supersedesDocumentId = fields.supersedesDocumentId;
  }
  if (fields.isCurrent) {
    const lower = fields.isCurrent.toLowerCase();
    metadata.isCurrent =
      lower === "true" || lower === "1" || lower === "yes";
  }
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
  if (record.topic) meta.topic = record.topic;
  if (record.department) meta.department = record.department;
  if (record.property) meta.property = record.property;
  if (record.source) meta.source = record.source;
  if (record.documentDate) meta.document_date = record.documentDate;
  if (record.page != null) meta.page = String(record.page);
  if (record.sheet) meta.sheet = record.sheet;
  if (record.slide != null) meta.slide = String(record.slide);
  if (record.chunkNumber != null) meta.chunk_number = String(record.chunkNumber);
  if (record.isCurrent) meta.is_current = "true";
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
  department?: string;
  property?: string;
  topic?: string;
  person?: string;
  customer?: string;
  supplier?: string;
}

export function hasActiveFilters(filters?: KnowledgeSearchFilters): boolean {
  if (!filters) return false;
  return Object.values(filters).some(
    (value) => value !== undefined && String(value).trim() !== ""
  );
}

export async function getFilteredDocumentIds(
  env: { CADDINGTON_BUSINESS_DATA: D1Database },
  filters?: KnowledgeSearchFilters
): Promise<number[] | null> {
  if (!hasActiveFilters(filters)) return null;

  const conditions: string[] = ["status = 'indexed'"];
  const binds: unknown[] = [];

  const addMetaLike = (jsonField: string, value?: string) => {
    if (!value?.trim()) return;
    conditions.push(
      `LOWER(COALESCE(json_extract(metadata, '$.${jsonField}'), '')) LIKE ?`
    );
    binds.push(`%${value.trim().toLowerCase()}%`);
  };

  addMetaLike("company", filters?.company);
  addMetaLike("project", filters?.project);
  addMetaLike("category", filters?.category);
  addMetaLike("source", filters?.source);
  addMetaLike("documentDate", filters?.document_date);
  addMetaLike("department", filters?.department);
  addMetaLike("property", filters?.property);
  addMetaLike("topic", filters?.topic);
  addMetaLike("person", filters?.person);
  addMetaLike("customer", filters?.customer);
  addMetaLike("supplier", filters?.supplier);

  if (filters?.document_type?.trim()) {
    const dt = filters.document_type.trim().toLowerCase();
    conditions.push(
      `(LOWER(COALESCE(json_extract(metadata, '$.sourceFormat'), '')) LIKE ? OR LOWER(COALESCE(mime_type, '')) LIKE ?)`
    );
    binds.push(`%${dt}%`, `%${dt}%`);
  }

  if (filters?.title?.trim()) {
    conditions.push("LOWER(title) LIKE ?");
    binds.push(`%${filters.title.trim().toLowerCase()}%`);
  }

  if (filters?.filename?.trim()) {
    conditions.push(
      "LOWER(COALESCE(json_extract(metadata, '$.originalFilename'), '')) LIKE ?"
    );
    binds.push(`%${filters.filename.trim().toLowerCase()}%`);
  }

  const sql = `SELECT id FROM knowledge_documents WHERE ${conditions.join(" AND ")}`;
  const rows = await env.CADDINGTON_BUSINESS_DATA.prepare(sql)
    .bind(...binds)
    .all();

  return rows.results.map((row) =>
    Number((row as Record<string, unknown>).id)
  );
}
