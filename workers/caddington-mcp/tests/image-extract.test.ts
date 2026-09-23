import { describe, expect, it } from "vitest";
import {
  getImageDimensions,
  imageContentStatus,
  isImageDocument,
  normalizeImageMimeType,
} from "../src/image-extract";

describe("image type detection", () => {
  it("detects supported image MIME types", () => {
    expect(isImageDocument("image/jpeg", "photo.jpg")).toBe(true);
    expect(isImageDocument("image/png", "scan.png")).toBe(true);
    expect(isImageDocument("image/webp", "banner.webp")).toBe(true);
    expect(normalizeImageMimeType("image/jpg", "x.jpg")).toBe("image/jpeg");
    expect(isImageDocument("application/pdf", "doc.pdf")).toBe(false);
  });

  it("detects images by file extension", () => {
    expect(isImageDocument("application/octet-stream", "photo.jpeg")).toBe(true);
    expect(normalizeImageMimeType("application/octet-stream", "photo.jpeg")).toBe(
      "image/jpeg"
    );
  });
});

describe("image content status", () => {
  it("flags empty and thin content", () => {
    expect(imageContentStatus("")).toBe("no_searchable_content");
    expect(imageContentStatus("tiny")).toBe("requires_manual_review");
    expect(
      imageContentStatus(
        "Project Falcon approved budget £317,450 manager Harriet Green"
      )
    ).toBe("ok");
  });
});

describe("image dimensions", () => {
  it("reads PNG dimensions from header", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x80,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    const dims = getImageDimensions(png, "image/png");
    expect(dims).toEqual({ width: 256, height: 128 });
  });
});
