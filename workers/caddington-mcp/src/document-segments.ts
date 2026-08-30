export type BusinessDocumentFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "txt"
  | "md"
  | "csv"
  | "image"
  | "other";

export interface SegmentMetadata {
  page?: number;
  section?: string;
  heading?: string;
  sheet?: string;
  slide?: number;
  fileType?: string;
  extractionMethod?: string;
  visionStatus?: string;
  imageWidth?: number;
  imageHeight?: number;
  chunkNumber?: number;
}

export interface TextSegment {
  text: string;
  metadata: SegmentMetadata;
}

export interface ChunkWithMetadata {
  content: string;
  metadata: SegmentMetadata;
}

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;

const PAGE_LINE_PATTERNS: RegExp[] = [
  /^<!--\s*page\s*:\s*(\d+)\s*-->$/i,
  /^\[Page\s+(\d+)\]$/i,
  /^---+\s*page\s+(\d+)\s*---+$/i,
  /^page\s+(\d+)\s*$/i,
];

export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length);
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter((c) => c.length > 0);
}

function parsePageLine(line: string): number | undefined {
  for (const pattern of PAGE_LINE_PATTERNS) {
    const match = line.trim().match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function applyHeadingMetadata(
  headingText: string,
  format: BusinessDocumentFormat,
  metadata: SegmentMetadata
): void {
  metadata.heading = headingText;
  metadata.section = headingText;

  if (format === "xlsx") {
    const sheetMatch = headingText.match(
      /^(?:sheet|worksheet)\s*[:\-]?\s*(.+)$/i
    );
    if (sheetMatch) {
      metadata.sheet = sheetMatch[1].trim();
      metadata.section = metadata.sheet;
    } else {
      metadata.sheet = headingText;
    }
  }

  if (format === "pptx") {
    const slideMatch = headingText.match(
      /^slide\s+(\d+)(?:\s*[:\-]\s*(.+))?$/i
    );
    if (slideMatch) {
      metadata.slide = Number(slideMatch[1]);
      if (slideMatch[2]?.trim()) {
        metadata.heading = slideMatch[2].trim();
        metadata.section = metadata.heading;
      }
    }
  }
}

export function parseMarkdownToSegments(
  markdown: string,
  format: BusinessDocumentFormat
): TextSegment[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];

  const lines = normalized.split("\n");
  const segments: TextSegment[] = [];
  let buffer: string[] = [];
  let current: SegmentMetadata = {};

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (!text) {
      buffer = [];
      return;
    }
    segments.push({
      text,
      metadata: { ...current },
    });
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      current = {};
      applyHeadingMetadata(headingMatch[2].trim(), format, current);
      buffer.push(line);
      continue;
    }

    if (format === "pdf") {
      const page = parsePageLine(line);
      if (page !== undefined) {
        flush();
        current = { ...current, page };
        continue;
      }
    }

    buffer.push(line);
  }

  flush();

  if (segments.length === 0 && normalized.trim()) {
    return [{ text: normalized.trim(), metadata: {} }];
  }

  return segments;
}

export function plainTextToSegments(
  text: string,
  format: BusinessDocumentFormat
): TextSegment[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  if (format === "md") {
    return parseMarkdownToSegments(normalized, "md");
  }

  if (format === "csv") {
    return [{ text: normalized, metadata: { section: "csv" } }];
  }

  return [{ text: normalized, metadata: {} }];
}

export function chunkSegments(segments: TextSegment[]): ChunkWithMetadata[] {
  const chunks: ChunkWithMetadata[] = [];

  for (const segment of segments) {
    const parts = chunkText(segment.text);
    for (const part of parts) {
      chunks.push({
        content: part,
        metadata: { ...segment.metadata },
      });
    }
  }

  return chunks;
}

export function meaningfulTextLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export const PDF_OCR_MIN_CHARS = 40;

export function pdfRequiresOcr(text: string): boolean {
  return meaningfulTextLength(text) < PDF_OCR_MIN_CHARS;
}

export function segmentMetadataToJson(metadata: SegmentMetadata): string {
  const payload: Record<string, string | number> = {};
  if (metadata.page != null) payload.page = metadata.page;
  if (metadata.section) payload.section = metadata.section;
  if (metadata.heading) payload.heading = metadata.heading;
  if (metadata.sheet) payload.sheet = metadata.sheet;
  if (metadata.slide != null) payload.slide = metadata.slide;
  if (metadata.fileType) payload.fileType = metadata.fileType;
  if (metadata.extractionMethod) payload.extractionMethod = metadata.extractionMethod;
  if (metadata.visionStatus) payload.visionStatus = metadata.visionStatus;
  if (metadata.imageWidth != null) payload.imageWidth = metadata.imageWidth;
  if (metadata.imageHeight != null) payload.imageHeight = metadata.imageHeight;
  if (metadata.chunkNumber != null) payload.chunkNumber = metadata.chunkNumber;
  return JSON.stringify(payload);
}

export function parseSegmentMetadataJson(
  raw: string | null | undefined
): SegmentMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const metadata: SegmentMetadata = {};
    if (typeof parsed.page === "number") metadata.page = parsed.page;
    if (typeof parsed.section === "string") metadata.section = parsed.section;
    if (typeof parsed.heading === "string") metadata.heading = parsed.heading;
    if (typeof parsed.sheet === "string") metadata.sheet = parsed.sheet;
    if (typeof parsed.slide === "number") metadata.slide = parsed.slide;
    if (typeof parsed.fileType === "string") metadata.fileType = parsed.fileType;
    if (typeof parsed.extractionMethod === "string") {
      metadata.extractionMethod = parsed.extractionMethod;
    }
    if (typeof parsed.visionStatus === "string") {
      metadata.visionStatus = parsed.visionStatus;
    }
    if (typeof parsed.imageWidth === "number") {
      metadata.imageWidth = parsed.imageWidth;
    }
    if (typeof parsed.imageHeight === "number") {
      metadata.imageHeight = parsed.imageHeight;
    }
    if (typeof parsed.chunkNumber === "number") {
      metadata.chunkNumber = parsed.chunkNumber;
    }
    return metadata;
  } catch {
    return {};
  }
}

export function segmentMetadataToVectorFields(
  metadata: SegmentMetadata
): Record<string, string> {
  const out: Record<string, string> = {};
  if (metadata.page != null) out.page = String(metadata.page);
  if (metadata.section) out.section = metadata.section;
  if (metadata.heading) out.heading = metadata.heading;
  if (metadata.sheet) out.sheet = metadata.sheet;
  if (metadata.slide != null) out.slide = String(metadata.slide);
  if (metadata.fileType) out.fileType = metadata.fileType;
  if (metadata.extractionMethod) out.extractionMethod = metadata.extractionMethod;
  if (metadata.visionStatus) out.visionStatus = metadata.visionStatus;
  if (metadata.imageWidth != null) out.imageWidth = String(metadata.imageWidth);
  if (metadata.imageHeight != null) {
    out.imageHeight = String(metadata.imageHeight);
  }
  if (metadata.chunkNumber != null) {
    out.chunkNumber = String(metadata.chunkNumber);
  }
  return out;
}

export function vectorFieldsToSegmentMetadata(
  meta: Record<string, unknown>
): SegmentMetadata {
  const metadata: SegmentMetadata = {};
  if (meta.page != null && meta.page !== "") {
    const page = Number(meta.page);
    if (!Number.isNaN(page)) metadata.page = page;
  }
  if (typeof meta.section === "string" && meta.section) {
    metadata.section = meta.section;
  }
  if (typeof meta.heading === "string" && meta.heading) {
    metadata.heading = meta.heading;
  }
  if (typeof meta.sheet === "string" && meta.sheet) {
    metadata.sheet = meta.sheet;
  }
  if (meta.slide != null && meta.slide !== "") {
    const slide = Number(meta.slide);
    if (!Number.isNaN(slide)) metadata.slide = slide;
  }
  if (typeof meta.fileType === "string" && meta.fileType) {
    metadata.fileType = meta.fileType;
  }
  if (typeof meta.extractionMethod === "string" && meta.extractionMethod) {
    metadata.extractionMethod = meta.extractionMethod;
  }
  if (typeof meta.visionStatus === "string" && meta.visionStatus) {
    metadata.visionStatus = meta.visionStatus;
  }
  if (meta.imageWidth != null && meta.imageWidth !== "") {
    const imageWidth = Number(meta.imageWidth);
    if (!Number.isNaN(imageWidth)) metadata.imageWidth = imageWidth;
  }
  if (meta.imageHeight != null && meta.imageHeight !== "") {
    const imageHeight = Number(meta.imageHeight);
    if (!Number.isNaN(imageHeight)) metadata.imageHeight = imageHeight;
  }
  if (meta.chunkNumber != null && meta.chunkNumber !== "") {
    const chunkNumber = Number(meta.chunkNumber);
    if (!Number.isNaN(chunkNumber)) metadata.chunkNumber = chunkNumber;
  }
  return metadata;
}
