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

export function hasActiveFilters(filters?: KnowledgeSearchFilters): boolean {
  if (!filters) return false;
  return Object.values(filters).some(
    (value) => value !== undefined && String(value).trim() !== ""
  );
}

export async function getFilteredDocumentIds(
  db: D1Database,
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
  const rows = await db.prepare(sql).bind(...binds).all();

  return rows.results.map((row) =>
    Number((row as Record<string, unknown>).id)
  );
}
