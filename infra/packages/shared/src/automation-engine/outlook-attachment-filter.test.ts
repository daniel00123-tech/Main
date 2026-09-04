import { describe, expect, it } from "vitest";
import { classifyOutlookAttachmentForKnowledge } from "./outlook-attachment-filter";

describe("Outlook attachment knowledge filter", () => {
  it("accepts PDF, DOCX, and XLSX business documents", () => {
    expect(classifyOutlookAttachmentForKnowledge({ filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 20_000 }).ingest).toBe(true);
    expect(
      classifyOutlookAttachmentForKnowledge({
        filename: "quote.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 12_000,
      }).ingest,
    ).toBe(true);
    expect(
      classifyOutlookAttachmentForKnowledge({
        filename: "costs.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 8_000,
      }).ingest,
    ).toBe(true);
  });

  it("skips inline images, logos, tracking pixels, and calendar chrome", () => {
    expect(
      classifyOutlookAttachmentForKnowledge({
        filename: "image001.png",
        mimeType: "image/png",
        isInline: true,
        sizeBytes: 2_000,
      }).failureCode,
    ).toBe("SKIP_INLINE");
    expect(
      classifyOutlookAttachmentForKnowledge({
        filename: "logo.png",
        mimeType: "image/png",
        sizeBytes: 4_000,
      }).failureCode,
    ).toBe("SKIP_DECORATIVE_IMAGE");
    expect(
      classifyOutlookAttachmentForKnowledge({
        filename: "pixel.gif",
        mimeType: "image/gif",
        sizeBytes: 800,
      }).failureCode,
    ).toBe("SKIP_DECORATIVE_IMAGE");
    expect(
      classifyOutlookAttachmentForKnowledge({
        filename: "invite.ics",
        mimeType: "text/calendar",
        sizeBytes: 1_200,
      }).failureCode,
    ).toBe("SKIP_CALENDAR_CHROME");
  });

  it("rejects unsupported archives", () => {
    expect(
      classifyOutlookAttachmentForKnowledge({
        filename: "payload.zip",
        mimeType: "application/zip",
        sizeBytes: 40_000,
      }).failureCode,
    ).toBe("UNSUPPORTED_FORMAT");
  });
});
