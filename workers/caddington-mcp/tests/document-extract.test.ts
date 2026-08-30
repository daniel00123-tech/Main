import { describe, expect, it } from "vitest";
import {
  detectDocumentFormat,
  isPlainTextDocument,
  isWorkersAiConvertible,
} from "../src/document-extract";
import { isImageDocument } from "../src/image-extract";
import {
  chunkSegments,
  chunkText,
  parseMarkdownToSegments,
  pdfRequiresOcr,
  plainTextToSegments,
  segmentMetadataToJson,
  vectorFieldsToSegmentMetadata,
} from "../src/document-segments";

describe("document type detection", () => {
  it("detects plain text types", () => {
    expect(isPlainTextDocument("text/plain", "notes.txt")).toBe(true);
    expect(isPlainTextDocument("application/octet-stream", "readme.md")).toBe(
      true
    );
    expect(isPlainTextDocument("text/csv", "export.csv")).toBe(true);
    expect(detectDocumentFormat("text/plain", "notes.txt")).toBe("txt");
    expect(detectDocumentFormat("text/markdown", "guide.md")).toBe("md");
    expect(detectDocumentFormat("text/csv", "data.csv")).toBe("csv");
  });

  it("detects business formats for Workers AI conversion", () => {
    expect(
      isWorkersAiConvertible("application/pdf", "policy.pdf")
    ).toBe(true);
    expect(
      isWorkersAiConvertible(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "handbook.docx"
      )
    ).toBe(true);
    expect(
      isWorkersAiConvertible(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "budget.xlsx"
      )
    ).toBe(true);
    expect(
      isWorkersAiConvertible(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "deck.pptx"
      )
    ).toBe(true);
    expect(detectDocumentFormat("application/pdf", "policy.pdf")).toBe("pdf");
    expect(detectDocumentFormat("application/octet-stream", "budget.xlsx")).toBe(
      "xlsx"
    );
    expect(detectDocumentFormat("application/octet-stream", "deck.pptx")).toBe(
      "pptx"
    );
  });

  it("does not treat plain text as AI convertible only", () => {
    expect(isWorkersAiConvertible("text/plain", "notes.txt")).toBe(false);
    expect(isPlainTextDocument("text/plain", "notes.txt")).toBe(true);
  });

  it("detects image formats separately from office documents", () => {
    expect(detectDocumentFormat("image/jpeg", "photo.jpg")).toBe("image");
    expect(isImageDocument("image/png", "scan.png")).toBe(true);
    expect(isWorkersAiConvertible("image/jpeg", "photo.jpg")).toBe(false);
  });
});

describe("markdown segment parsing", () => {
  it("tracks headings for docx-style markdown", () => {
    const markdown = `# Introduction\nIntro body.\n\n## Policies\nPolicy details here.`;
    const segments = parseMarkdownToSegments(markdown, "docx");
    expect(segments.length).toBe(2);
    expect(segments[0].metadata.heading).toBe("Introduction");
    expect(segments[0].text).toContain("Intro body.");
    expect(segments[1].metadata.heading).toBe("Policies");
    expect(segments[1].text).toContain("Policy details");
  });

  it("tracks PDF page markers", () => {
    const markdown = `<!-- page: 1 -->\nFirst page text.\n\nPage 2\nSecond page text.`;
    const segments = parseMarkdownToSegments(markdown, "pdf");
    expect(segments.some((s) => s.metadata.page === 1)).toBe(true);
    expect(segments.some((s) => s.metadata.page === 2)).toBe(true);
    expect(segments.some((s) => s.text.includes("First page"))).toBe(true);
    expect(segments.some((s) => s.text.includes("Second page"))).toBe(true);
  });

  it("tracks spreadsheet sheet headings", () => {
    const markdown = `# Sheet: Revenue\nRow data\n\n# Sheet: Costs\nMore rows`;
    const segments = parseMarkdownToSegments(markdown, "xlsx");
    expect(segments[0].metadata.sheet).toBe("Revenue");
    expect(segments[1].metadata.sheet).toBe("Costs");
  });

  it("tracks slide headings for presentations", () => {
    const markdown = `# Slide 1 - Welcome\nHello\n\n# Slide 2 - Agenda\nTopics`;
    const segments = parseMarkdownToSegments(markdown, "pptx");
    expect(segments[0].metadata.slide).toBe(1);
    expect(segments[0].metadata.heading).toBe("Welcome");
    expect(segments[1].metadata.slide).toBe(2);
    expect(segments[1].metadata.heading).toBe("Agenda");
  });
});

describe("chunking and OCR heuristics", () => {
  it("chunks long segment text with overlap", () => {
    const text = "a".repeat(1000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(900);
  });

  it("chunks segments while preserving metadata", () => {
    const segments = plainTextToSegments("# Title\n" + "word ".repeat(400), "md");
    const chunks = chunkSegments(segments);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.metadata.heading === "Title")).toBe(true);
  });

  it("flags low-text PDFs for OCR", () => {
    expect(pdfRequiresOcr("short")).toBe(true);
    expect(pdfRequiresOcr("x".repeat(80))).toBe(false);
  });

  it("serializes metadata for storage and vectorize", () => {
    const json = segmentMetadataToJson({
      page: 3,
      heading: "Safety",
      section: "Safety",
    });
    expect(JSON.parse(json)).toEqual({
      page: 3,
      heading: "Safety",
      section: "Safety",
    });
    const roundTrip = vectorFieldsToSegmentMetadata({
      page: "3",
      heading: "Safety",
      section: "Safety",
    });
    expect(roundTrip.page).toBe(3);
    expect(roundTrip.heading).toBe("Safety");
  });

  it("labels CSV uploads as csv section", () => {
    const segments = plainTextToSegments("a,b\n1,2", "csv");
    expect(segments[0].metadata.section).toBe("csv");
  });
});
