import { describe, expect, it } from "vitest";
import {
  isOcrSupportedMimeType,
  presentCustomerOcrStatus,
  presentOperatorOcrStatus,
  resolveExtractionOperatorState,
  shouldInvokeOcr,
} from "./types";

describe("OCR trigger", () => {
  it("invokes OCR only for requires_ocr canonical state", () => {
    expect(shouldInvokeOcr({ requiresOcr: true })).toBe(true);
    expect(shouldInvokeOcr({ documentStatus: "requires_ocr" })).toBe(true);
    expect(shouldInvokeOcr({ requiresOcr: false, extractionQuality: "good" })).toBe(false);
    expect(shouldInvokeOcr({ extractionQuality: "poor" })).toBe(false);
  });
});

describe("OCR mime allow-list", () => {
  it("accepts PDF and common images", () => {
    expect(isOcrSupportedMimeType("application/pdf")).toBe(true);
    expect(isOcrSupportedMimeType("image/jpeg")).toBe(true);
    expect(isOcrSupportedMimeType("image/png")).toBe(true);
    expect(isOcrSupportedMimeType("image/tiff")).toBe(true);
    expect(isOcrSupportedMimeType("application/vnd.ms-excel")).toBe(false);
  });
});

describe("OCR customer wording", () => {
  it("hides Azure implementation details", () => {
    expect(presentCustomerOcrStatus("ocr_processing")).toBe("Processing document text");
    expect(presentCustomerOcrStatus("ocr_completed")).toBe("Document processed");
    expect(presentCustomerOcrStatus("ocr_failed")).toBe("Document couldn't be read automatically");
    expect(presentCustomerOcrStatus("ocr_limit_exceeded")).toBe(
      "Document couldn't be read automatically",
    );
    expect(presentCustomerOcrStatus("ocr_processing")).not.toMatch(/Azure|prebuilt|2024-11-30/i);
  });

  it("keeps operator wording technical", () => {
    expect(presentOperatorOcrStatus("ocr_limit_exceeded")).toBe("OCR page limit exceeded");
    expect(presentOperatorOcrStatus("requires_ocr")).toBe("Requires OCR");
  });
});

describe("extraction operator states", () => {
  it("maps native success, OCR success, failed, unsupported, and not-available", () => {
    expect(resolveExtractionOperatorState({ extractionQuality: "good" })).toBe("native_text_success");
    expect(resolveExtractionOperatorState({ ocrStatus: "ocr_completed" })).toBe("ocr_success");
    expect(resolveExtractionOperatorState({ ocrStatus: "ocr_failed" })).toBe("ocr_failed");
    expect(
      resolveExtractionOperatorState({
        requiresOcr: true,
        mimeType: "application/vnd.ms-excel",
      }),
    ).toBe("unsupported");
    expect(
      resolveExtractionOperatorState({
        requiresOcr: true,
        fallbackOutcome: "ocr_not_available",
        azureConfigured: false,
      }),
    ).toBe("ocr_not_available");
    expect(
      resolveExtractionOperatorState({
        extractionQuality: "heading_only",
        azureConfigured: true,
      }),
    ).toBe("low_text_warning");
  });
});
