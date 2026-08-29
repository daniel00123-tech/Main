/**
 * PDF extraction quality assessment — shared logic mirrored in caddington-mcp build patches.
 */

export type PdfExtractionAssessment = {
  pageCount: number;
  pagesWithText: number;
  extractedCharacterCount: number;
  substantiveCharacterCount: number;
  extractionMethod: string;
  extractionQuality: "good" | "poor" | "heading_only" | "requires_ocr";
  fallbackRequired: boolean;
  requiresOcr: boolean;
};

const PAGE_MARKER_RE = /^(#{1,6}\s+)?page\s+\d+\s*$/i;
const SUBSTANTIVE_MIN_CHARS = 80;
const HEADING_ONLY_PAGE_RATIO = 0.5;

export function stripPdfPageMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => !PAGE_MARKER_RE.test(line.trim()))
    .join("\n")
    .replace(/^(#{1,6}\s+)(.+)$/gm, "$2")
    .trim();
}

export function meaningfulTextLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export type PdfSegment = { text: string; metadata?: { page?: number } };

export function assessPdfExtractionQuality(
  segments: PdfSegment[],
  rawMarkdown?: string,
): PdfExtractionAssessment {
  const pageSegments = segments.filter((s) => s.metadata?.page != null);
  const units = pageSegments.length > 0 ? pageSegments : segments;
  const pageCount = pageSegments.length > 0 ? pageSegments.length : Math.max(units.length, 1);

  let pagesWithText = 0;
  for (const segment of units) {
    const substantive = meaningfulTextLength(stripPdfPageMarkers(segment.text));
    if (substantive >= 40) pagesWithText++;
  }

  const joined = segments.map((s) => s.text).join("\n\n");
  const extractedCharacterCount = meaningfulTextLength(joined);
  const substantiveCharacterCount = meaningfulTextLength(stripPdfPageMarkers(joined));

  let extractionQuality: PdfExtractionAssessment["extractionQuality"] = "good";
  let fallbackRequired = false;
  let requiresOcr = false;

  if (substantiveCharacterCount < 40) {
    requiresOcr = true;
    extractionQuality = "requires_ocr";
    fallbackRequired = true;
  } else if (
    pageCount >= 2 &&
    pagesWithText / pageCount < HEADING_ONLY_PAGE_RATIO
  ) {
    requiresOcr = true;
    extractionQuality = "heading_only";
    fallbackRequired = true;
  } else if (substantiveCharacterCount < SUBSTANTIVE_MIN_CHARS) {
    requiresOcr = true;
    extractionQuality = "poor";
    fallbackRequired = true;
  } else if (
    rawMarkdown &&
    /^(\s*(?:#{1,6}\s+)?page\s+\d+\s*\n?)+$/i.test(stripPdfPageMarkers(rawMarkdown)) &&
    pageCount >= 2
  ) {
    requiresOcr = true;
    extractionQuality = "heading_only";
    fallbackRequired = true;
  }

  return {
    pageCount,
    pagesWithText,
    extractedCharacterCount,
    substantiveCharacterCount,
    extractionMethod: "ai_to_markdown",
    extractionQuality,
    fallbackRequired,
    requiresOcr,
  };
}
