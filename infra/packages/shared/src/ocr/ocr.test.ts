import { describe, expect, it } from "vitest";
import {
  isOcrSupportedMimeType,
  presentCustomerOcrStatus,
  presentOperatorOcrStatus,
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
