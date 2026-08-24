import type { TextSegment } from "./document-segments";
import {
  meaningfulTextLength,
  parseMarkdownToSegments,
} from "./document-segments";
import type { Env } from "./db";

export const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export const IMAGE_MIN_SEARCHABLE_CHARS = 40;
export const IMAGE_EXTRACTION_METHOD = "workers_ai_to_markdown";
/** Vision summarization inside Workers AI toMarkdown image conversion. */
export const IMAGE_VISION_MODEL = "@cf/unum/uform-gen2-qwen-500m";

export interface ImageDimensions {
  width: number;
  height: number;
}

export type ImageContentStatus =
  | "ok"
  | "no_searchable_content"
  | "requires_manual_review";

export interface ImageExtractionResult {
  segments: TextSegment[];
  rawText: string;
  rawTextLength: number;
  contentStatus: ImageContentStatus;
  dimensions?: ImageDimensions;
  extractionMethod: string;
  visionModel: string;
  visionStatus: string;
  mimeType: string;
  fileType: string;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

export function normalizeImageMimeType(
  mimeType: string,
  filename: string
): string | null {
  const lowerMime = mimeType.toLowerCase().split(";")[0].trim();
  const lowerName = filename.toLowerCase();

  if (SUPPORTED_IMAGE_MIME_TYPES.has(lowerMime)) {
    return lowerMime === "image/jpg" ? "image/jpeg" : lowerMime;
  }

  if (lowerName.endsWith(".jpeg") || lowerName.endsWith(".jpg")) {
    return "image/jpeg";
  }
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".webp")) return "image/webp";

  return null;
}

export function isImageDocument(mimeType: string, filename: string): boolean {
  return normalizeImageMimeType(mimeType, filename) !== null;
}

export function imageContentStatus(text: string): ImageContentStatus {
  const meaningful = meaningfulTextLength(text);
  if (meaningful === 0) return "no_searchable_content";
  if (meaningful < IMAGE_MIN_SEARCHABLE_CHARS) {
    return "requires_manual_review";
  }
  return "ok";
}

export function getImageDimensions(
  bytes: Uint8Array,
  mimeType: string
): ImageDimensions | undefined {
  const mime = mimeType.toLowerCase();

  if (mime === "image/png" && bytes.length >= 24 && bytes[0] === 0x89) {
    const width =
      (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height =
      (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    if (width > 0 && height > 0) return { width, height };
  }

  if (
    (mime === "image/jpeg" || mime === "image/jpg") &&
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8
  ) {
    let offset = 2;
    while (offset < bytes.length - 8) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker === 0xc0 || marker === 0xc2) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        if (width > 0 && height > 0) return { width, height };
        break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }

  if (
    mime === "image/webp" &&
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49
  ) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8 ") {
      const width = ((bytes[26] | (bytes[27] << 8)) & 0x3fff) + 1;
      const height = ((bytes[28] | (bytes[29] << 8)) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits =
        bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
    }
    if (chunk === "VP8X" && bytes.length >= 30) {
      const width =
        1 +
        bytes[24] +
        (bytes[25] << 8) +
        (bytes[26] << 16);
      const height =
        1 +
        bytes[27] +
        (bytes[28] << 8) +
        (bytes[29] << 16);
      if (width > 0 && height > 0) return { width, height };
    }
  }

  return undefined;
}

function baseSegmentMetadata(
  mimeType: string,
  dimensions?: ImageDimensions,
  visionStatus = "completed"
): TextSegment["metadata"] {
  const fileType = extensionForMime(mimeType);
  const metadata: TextSegment["metadata"] = {
    fileType,
    extractionMethod: IMAGE_EXTRACTION_METHOD,
    visionStatus,
    section: "image",
  };
  if (dimensions) {
    metadata.imageWidth = dimensions.width;
    metadata.imageHeight = dimensions.height;
  }
  return metadata;
}

export async function extractImageDocument(
  env: Env,
  bytes: ArrayBuffer,
  mimeType: string,
  filename: string
): Promise<ImageExtractionResult> {
  const resolvedMime = normalizeImageMimeType(mimeType, filename);
  if (!resolvedMime) {
    throw new Error(
      `Unsupported image type: ${mimeType || filename}. Supported: JPG, JPEG, PNG, WEBP.`
    );
  }

  const fileType = extensionForMime(resolvedMime);
  const uint8 = new Uint8Array(bytes);
  const dimensions = getImageDimensions(uint8, resolvedMime);
  const baseMeta = baseSegmentMetadata(resolvedMime, dimensions);

  const blob = new Blob([bytes], { type: resolvedMime });
  const safeName =
    filename.includes(".") ? filename.split("/").pop() ?? filename : `${filename}.${fileType}`;

  const result = await env.AI.toMarkdown(
    { name: safeName, blob },
    {
      conversionOptions: {
        output: { format: "markdown" },
        image: { descriptionLanguage: "en" },
      },
    }
  );

  if (result.format === "error") {
    return {
      segments: [],
      rawText: "",
      rawTextLength: 0,
      contentStatus: "requires_manual_review",
      dimensions,
      extractionMethod: IMAGE_EXTRACTION_METHOD,
      visionModel: IMAGE_VISION_MODEL,
      visionStatus: "failed",
      mimeType: resolvedMime,
      fileType,
    };
  }

  const markdown = result.data.replace(/\r\n/g, "\n").trim();
  const parsed = parseMarkdownToSegments(markdown, "image");
  const segments: TextSegment[] =
    parsed.length > 0
      ? parsed.map((segment) => ({
          text: segment.text,
          metadata: {
            ...baseMeta,
            ...segment.metadata,
            heading: segment.metadata.heading,
            section: segment.metadata.section ?? segment.metadata.heading ?? "image",
          },
        }))
      : markdown
        ? [{ text: markdown, metadata: { ...baseMeta } }]
        : [];

  const rawText = segments.map((s) => s.text).join("\n\n").trim();
  const contentStatus = imageContentStatus(rawText);

  return {
    segments,
    rawText,
    rawTextLength: rawText.length,
    contentStatus,
    dimensions,
    extractionMethod: IMAGE_EXTRACTION_METHOD,
    visionModel: IMAGE_VISION_MODEL,
    visionStatus: contentStatus === "ok" ? "completed" : "partial",
    mimeType: resolvedMime,
    fileType,
  };
}
