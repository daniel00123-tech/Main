/** Shared Outlook attachment knowledge filters — no provider I/O. */

export const OUTLOOK_KNOWLEDGE_EXTENSIONS = [
  "pdf",
  "docx",
  "xlsx",
  "csv",
  "txt",
  "pptx",
  "doc",
  "xls",
] as const;

export const OUTLOOK_KNOWLEDGE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
]);

const DECORATIVE_NAME =
  /^(image\d+|logo|signature|sig|banner|footer|header|icon|spacer|pixel|tracking|tracker|openid-sso|oleobject)/i;
const CALENDAR_CHROME = /\.(ics|vcf|winmail\.dat)$/i;
const TINY_IMAGE_BYTES = 12_288;

export type OutlookAttachmentFilterInput = {
  filename?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  isInline?: boolean | null;
  contentId?: string | null;
};

export type OutlookAttachmentFilterResult = {
  ingest: boolean;
  skipReason: string | null;
  failureCode: string | null;
};

function extensionOf(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed.includes(".")) return "";
  return trimmed.split(".").pop()?.toLowerCase() ?? "";
}

export function classifyOutlookAttachmentForKnowledge(
  input: OutlookAttachmentFilterInput,
): OutlookAttachmentFilterResult {
  const filename = (input.filename ?? "").trim();
  const mime = (input.mimeType ?? "").trim().toLowerCase();
  const size = typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes) ? input.sizeBytes : null;
  const ext = extensionOf(filename);
  const image = mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(ext);

  if (input.isInline) {
    return { ingest: false, skipReason: "inline image or signature asset", failureCode: "SKIP_INLINE" };
  }
  if (input.contentId && image) {
    return { ingest: false, skipReason: "embedded content-id image", failureCode: "SKIP_EMBEDDED_IMAGE" };
  }
  if (image && (size == null || size <= TINY_IMAGE_BYTES)) {
    return { ingest: false, skipReason: "tiny decorative image", failureCode: "SKIP_DECORATIVE_IMAGE" };
  }
  if (filename && DECORATIVE_NAME.test(filename.replace(/\.[^.]+$/, ""))) {
    return { ingest: false, skipReason: "logo, signature, or tracking asset", failureCode: "SKIP_DECORATIVE_NAME" };
  }
  if (filename && CALENDAR_CHROME.test(filename)) {
    return { ingest: false, skipReason: "calendar or contact chrome", failureCode: "SKIP_CALENDAR_CHROME" };
  }
  if (image) {
    return { ingest: false, skipReason: "non-knowledge image", failureCode: "SKIP_IMAGE" };
  }
  if (OUTLOOK_KNOWLEDGE_MIME_TYPES.has(mime) || OUTLOOK_KNOWLEDGE_EXTENSIONS.includes(ext as (typeof OUTLOOK_KNOWLEDGE_EXTENSIONS)[number])) {
    return { ingest: true, skipReason: null, failureCode: null };
  }
  return { ingest: false, skipReason: "unsupported format", failureCode: "UNSUPPORTED_FORMAT" };
}
