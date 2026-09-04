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
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "webp",
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
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
]);

const DECORATIVE_NAME =
  /^(image\d+|logo|signature|sig|banner|footer|header|icon|spacer|pixel|tracking|tracker|openid-sso|oleobject)/i;
const CALENDAR_CHROME = /\.(ics|vcf|winmail\.dat)$/i;
const UNSAFE_EXTENSIONS = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "scr",
  "ps1",
  "vbs",
  "js",
  "jse",
  "msi",
  "dll",
  "cpl",
  "jar",
  "iso",
]);
const UNSAFE_MIME = /^(application\/x-msdownload|application\/x-msdos-program|application\/x-executable|application\/javascript)/i;
const TINY_IMAGE_BYTES = 12_288;

export type OutlookAttachmentClass = "knowledge" | "junk" | "unsupported" | "unsafe";

export type OutlookAttachmentFilterInput = {
  filename?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  isInline?: boolean | null;
  contentId?: string | null;
};

export type OutlookAttachmentFilterResult = {
  ingest: boolean;
  store: boolean;
  classification: OutlookAttachmentClass;
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
  const image = mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"].includes(ext);

  if (UNSAFE_EXTENSIONS.has(ext) || UNSAFE_MIME.test(mime)) {
    return {
      ingest: false,
      store: true,
      classification: "unsafe",
      skipReason: "unsafe binary quarantined",
      failureCode: "UNSAFE_TYPE",
    };
  }
  if (input.isInline) {
    return {
      ingest: false,
      store: false,
      classification: "junk",
      skipReason: "inline image or signature asset",
      failureCode: "SKIP_INLINE",
    };
  }
  if (input.contentId && image) {
    return {
      ingest: false,
      store: false,
      classification: "junk",
      skipReason: "embedded content-id image",
      failureCode: "SKIP_EMBEDDED_IMAGE",
    };
  }
  if (image && (size == null || size <= TINY_IMAGE_BYTES)) {
    return {
      ingest: false,
      store: false,
      classification: "junk",
      skipReason: "tiny decorative image",
      failureCode: "SKIP_DECORATIVE_IMAGE",
    };
  }
  if (filename && DECORATIVE_NAME.test(filename.replace(/\.[^.]+$/, ""))) {
    return {
      ingest: false,
      store: false,
      classification: "junk",
      skipReason: "logo, signature, or tracking asset",
      failureCode: "SKIP_DECORATIVE_NAME",
    };
  }
  if (filename && CALENDAR_CHROME.test(filename)) {
    return {
      ingest: false,
      store: false,
      classification: "junk",
      skipReason: "calendar or contact chrome",
      failureCode: "SKIP_CALENDAR_CHROME",
    };
  }
  if (OUTLOOK_KNOWLEDGE_MIME_TYPES.has(mime) || OUTLOOK_KNOWLEDGE_EXTENSIONS.includes(ext as (typeof OUTLOOK_KNOWLEDGE_EXTENSIONS)[number])) {
    return { ingest: true, store: true, classification: "knowledge", skipReason: null, failureCode: null };
  }
  if (image) {
    return {
      ingest: false,
      store: false,
      classification: "junk",
      skipReason: "non-knowledge image",
      failureCode: "SKIP_IMAGE",
    };
  }
  return {
    ingest: false,
    store: true,
    classification: "unsupported",
    skipReason: "unsupported format",
    failureCode: "UNSUPPORTED_TYPE",
  };
}
