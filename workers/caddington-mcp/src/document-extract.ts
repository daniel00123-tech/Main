import type { BusinessDocumentFormat, TextSegment } from "./document-segments";
import {
  parseMarkdownToSegments,
  pdfRequiresOcr,
  plainTextToSegments,
} from "./document-segments";
import type { Env } from "./db";

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export class RequiresOcrError extends Error {
  readonly code = "REQUIRES_OCR";

  constructor(message = "Document requires OCR before indexing.") {
    super(message);
    this.name = "RequiresOcrError";
  }
}

export interface ExtractedDocument {
  format: BusinessDocumentFormat;
  segments: TextSegment[];
  requiresOcr: boolean;
  rawTextLength: number;
}

export function detectDocumentFormat(
  mimeType: string,
  filename: string
): BusinessDocumentFormat {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();

  if (lowerMime === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
  if (
    lowerMime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    return "docx";
  }
  if (
    lowerMime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    lowerMime === "application/vnd.ms-excel" ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".xls")
  ) {
    return "xlsx";
  }
  if (
    lowerMime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    lowerName.endsWith(".pptx")
  ) {
    return "pptx";
  }
  if (lowerName.endsWith(".md") || lowerMime === "text/markdown") return "md";
  if (lowerName.endsWith(".csv") || lowerMime === "text/csv") return "csv";
  if (
    lowerName.endsWith(".txt") ||
    lowerMime.startsWith("text/") ||
    lowerMime === "application/octet-stream"
  ) {
    return "txt";
  }

  return "other";
}

export function isPlainTextDocument(mimeType: string, filename: string): boolean {
  const format = detectDocumentFormat(mimeType, filename);
  return format === "txt" || format === "md" || format === "csv";
}

export function isWorkersAiConvertible(mimeType: string, filename: string): boolean {
  const format = detectDocumentFormat(mimeType, filename);
  return format === "pdf" || format === "docx" || format === "xlsx" || format === "pptx";
}

export function isLegacyWorkersAiConvertible(
  mimeType: string,
  filename: string
): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();
  return (
    lowerMime === "application/msword" ||
    lowerName.endsWith(".doc") ||
    lowerMime === "application/vnd.oasis.opendocument.text" ||
    lowerName.endsWith(".odt") ||
    lowerMime === "application/rtf" ||
    lowerName.endsWith(".rtf") ||
    lowerMime === "text/html" ||
    lowerName.endsWith(".html") ||
    lowerName.endsWith(".htm")
  );
}

function supportedFormatsMessage(): string {
  return "Supported: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV.";
}

export async function extractDocument(
  env: Env,
  bytes: ArrayBuffer,
  mimeType: string,
  filename: string
): Promise<ExtractedDocument> {
  const name = basename(filename);
  const format = detectDocumentFormat(mimeType, name);

  if (format === "txt" || format === "md" || format === "csv") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const segments = plainTextToSegments(text, format);
    const rawText = segments.map((s) => s.text).join("\n\n");
    return {
      format,
      segments,
      requiresOcr: false,
      rawTextLength: rawText.length,
    };
  }

  if (
    format !== "pdf" &&
    format !== "docx" &&
    format !== "xlsx" &&
    format !== "pptx" &&
    !isLegacyWorkersAiConvertible(mimeType, name)
  ) {
    throw new Error(
      `Unsupported document type: ${mimeType || name}. ${supportedFormatsMessage()}`
    );
  }

  const blob = new Blob([bytes], {
    type: mimeType || "application/octet-stream",
  });

  const result = await env.AI.toMarkdown(
    { name, blob },
    {
      conversionOptions: {
        output: { format: "markdown" },
        pdf: { metadata: true, images: { convert: false } },
        docx: { images: { convert: false } },
      },
    }
  );

  if (result.format === "error") {
    throw new Error(`Document conversion failed: ${result.error}`);
  }

  const markdown = result.data.replace(/\r\n/g, "\n").trim();
  const resolvedFormat =
    format === "other"
      ? detectDocumentFormat(result.mimetype ?? mimeType, name)
      : format;

  const segments = parseMarkdownToSegments(
    markdown,
    resolvedFormat === "other" ? "docx" : resolvedFormat
  );
  const rawText = segments.map((s) => s.text).join("\n\n");
  const requiresOcr =
    resolvedFormat === "pdf" && pdfRequiresOcr(rawText || markdown);

  if (!rawText && !requiresOcr) {
    throw new Error("No extractable text in document after conversion.");
  }

  return {
    format: resolvedFormat === "other" ? "docx" : resolvedFormat,
    segments,
    requiresOcr,
    rawTextLength: rawText.length,
  };
}

/** Flat text extraction for legacy callers; prefer extractDocument for indexing. */
export async function extractDocumentText(
  env: Env,
  bytes: ArrayBuffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const extracted = await extractDocument(env, bytes, mimeType, filename);
  if (extracted.requiresOcr) {
    throw new RequiresOcrError();
  }
  const text = extracted.segments.map((s) => s.text).join("\n\n").trim();
  if (!text) {
    throw new Error("No extractable text in document.");
  }
  return text;
}
