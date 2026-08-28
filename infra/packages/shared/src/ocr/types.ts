export const OCR_STATUSES = [
  "not_required",
  "requires_ocr",
  "ocr_pending",
  "ocr_processing",
  "ocr_completed",
  "ocr_failed",
  "ocr_limit_exceeded",
] as const;

export type OcrStatus = (typeof OCR_STATUSES)[number];

export const OCR_PROVIDER_ID = "azure_document_intelligence" as const;
export const OCR_MODEL_ID = "prebuilt-read" as const;
export const OCR_API_VERSION = "2024-11-30" as const;

export const DEFAULT_MAX_OCR_PAGES_PER_DOCUMENT = 50;
export const DEFAULT_MAX_OCR_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_OCR_PROVIDER_ATTEMPTS = 3;

export const OCR_SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/tiff",
  "image/tif",
] as const;

export type OcrSupportedMimeType = (typeof OCR_SUPPORTED_MIME_TYPES)[number];

export type OcrFailureCategory =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "PROVIDER"
  | "RATE_LIMIT"
  | "CONFIGURATION"
  | "DATA"
  | "TIMEOUT"
  | "INTERNAL"
  | "INSUFFICIENT_OCR_TEXT"
  | "PAGE_LIMIT"
  | "UNKNOWN";

export type OcrMetadata = {
  ocrProvider: typeof OCR_PROVIDER_ID;
  ocrModel: typeof OCR_MODEL_ID;
  ocrApiVersion: typeof OCR_API_VERSION;
  ocrStatus: OcrStatus;
  ocrPageCount?: number | null;
  ocrCompletedAt?: string | null;
  ocrAttemptCount?: number;
  ocrFailureCategory?: OcrFailureCategory | null;
  ocrContentFingerprint?: string | null;
};

export function isOcrSupportedMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (OCR_SUPPORTED_MIME_TYPES as readonly string[]).includes(normalized);
}

export function shouldInvokeOcr(input: {
  requiresOcr?: boolean;
  documentStatus?: string | null;
  extractionQuality?: string | null;
}): boolean {
  if (input.requiresOcr === true) return true;
  if (input.documentStatus === "requires_ocr") return true;
  return false;
}

export function presentCustomerOcrStatus(status: OcrStatus | string | null | undefined): string {
  switch (status) {
    case "ocr_pending":
    case "ocr_processing":
      return "Processing document text";
    case "ocr_completed":
    case "not_required":
      return "Document processed";
    case "ocr_failed":
    case "ocr_limit_exceeded":
    case "requires_ocr":
      return "Document couldn't be read automatically";
    default:
      return "Checking document text";
  }
}

export function presentOperatorOcrStatus(status: OcrStatus | string | null | undefined): string {
  switch (status) {
    case "not_required":
      return "OCR not required";
    case "requires_ocr":
      return "Requires OCR";
    case "ocr_pending":
      return "OCR pending";
    case "ocr_processing":
      return "OCR processing";
    case "ocr_completed":
      return "OCR succeeded";
    case "ocr_failed":
      return "OCR failed";
    case "ocr_limit_exceeded":
      return "OCR page limit exceeded";
    default:
      return "OCR status unknown";
  }
}
