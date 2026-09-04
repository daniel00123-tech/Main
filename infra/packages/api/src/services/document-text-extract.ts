/**
 * Extract readable text from downloaded Elvex/SharePoint file bytes.
 * Does not invent content. Office Open XML is parsed locally; PDFs use
 * Azure Document Intelligence when configured.
 */

import type { Env } from "../env";
import { createAzureOcrProvider } from "./ocr/azure-document-intelligence";

export type ExtractedDocumentText = {
  text: string;
  method: "utf8" | "docx" | "xlsx" | "pdf_ocr" | "none";
};

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript)|application\/csv)/i;
const DOCX_MIME = /wordprocessingml|officedocument\.wordprocessing|application\/vnd\.ms-word/i;
const XLSX_MIME = /spreadsheetml|officedocument\.spreadsheet|application\/vnd\.ms-excel/i;
const PDF_MIME = /application\/pdf/i;

export function looksLikeDocx(filename: string, mimeType?: string | null): boolean {
  return /\.docx$/i.test(filename) || Boolean(mimeType && DOCX_MIME.test(mimeType));
}

export function looksLikeXlsx(filename: string, mimeType?: string | null): boolean {
  return /\.xlsx$/i.test(filename) || Boolean(mimeType && XLSX_MIME.test(mimeType));
}

export function looksLikePdf(filename: string, mimeType?: string | null): boolean {
  return /\.pdf$/i.test(filename) || Boolean(mimeType && PDF_MIME.test(mimeType));
}

export function looksLikeRasterImage(filename: string, mimeType?: string | null): boolean {
  return /\.(jpe?g|png|tif|tiff|webp)$/i.test(filename) || Boolean(mimeType && /^image\//i.test(mimeType));
}

export function looksLikePlainText(filename: string, mimeType?: string | null): boolean {
  return /\.(txt|csv|md|json|xml|html|htm)$/i.test(filename) || Boolean(mimeType && TEXT_MIME.test(mimeType));
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
}

function xmlTextContent(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  for (const match of xml.matchAll(re)) {
    out.push(decodeXmlEntities(stripXmlTags(match[1] ?? "")));
  }
  return out;
}

function stripXmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function unzipEntry(bytes: Uint8Array, wanted: string): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (readU32(view, offset) !== 0x04034b50) break;
    const method = readU16(view, offset + 8);
    const compressedSize = readU32(view, offset + 18);
    const nameLen = readU16(view, offset + 26);
    const extraLen = readU16(view, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) return null;
    const name = decodeUtf8(bytes.subarray(nameStart, nameEnd));
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) return null;
    if (name === wanted) {
      const payload = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return payload;
      if (method === 8) return inflateRaw(payload);
      return null;
    }
    offset = dataEnd;
  }
  return null;
}

export function extractDocxXmlText(xml: string): string {
  const paragraphs = xml.split(/<\/w:p>/i);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const parts: string[] = [];
    for (const match of paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)) {
      parts.push(decodeXmlEntities(match[1] ?? ""));
    }
    const line = stripResidualOfficeXml(parts.join("")).replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  }
  return stripResidualOfficeXml(lines.join("\n")).trim();
}

function stripResidualOfficeXml(value: string): string {
  return value
    .replace(/<\/?w:[^>]+>/g, " ")
    .replace(/<\/?[a-zA-Z][\w:-]*[^>]*>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function extractXlsxSharedStrings(xml: string): string {
  const items = xml.split(/<\/si>/i);
  const values: string[] = [];
  for (const item of items) {
    const parts = xmlTextContent(`${item}</t>`, "t");
    const value = parts.join("").trim();
    if (value) values.push(value);
  }
  return values.join("\n").trim();
}

export async function extractOfficeText(bytes: Uint8Array, kind: "docx" | "xlsx"): Promise<string> {
  if (kind === "docx") {
    const xml = await unzipEntry(bytes, "word/document.xml");
    return xml ? extractDocxXmlText(decodeUtf8(xml)) : "";
  }
  const shared = await unzipEntry(bytes, "xl/sharedStrings.xml");
  if (shared) {
    const fromShared = extractXlsxSharedStrings(decodeUtf8(shared));
    if (fromShared) return fromShared;
  }
  const sheet = await unzipEntry(bytes, "xl/worksheets/sheet1.xml");
  if (!sheet) return "";
  return xmlTextContent(decodeUtf8(sheet), "v").join("\n").trim();
}

async function extractPdfText(env: Env, bytes: ArrayBuffer, mimeType: string): Promise<string> {
  const provider = createAzureOcrProvider(env);
  if (!provider) return "";
  try {
    const analyzed = await provider.analyze({
      bytes,
      mimeType: mimeType || "application/pdf",
      maxPages: 50,
    });
    return analyzed.text.trim();
  } catch {
    return "";
  }
}

export async function extractDocumentBytes(
  env: Env,
  input: { bytes: ArrayBuffer; filename: string; mimeType?: string | null },
): Promise<ExtractedDocumentText> {
  const filename = input.filename || "document";
  const mime = input.mimeType ?? "";
  const raw = new Uint8Array(input.bytes);

  if (looksLikePlainText(filename, mime)) {
    const text = decodeUtf8(raw).trim();
    return { text, method: text ? "utf8" : "none" };
  }
  if (looksLikeDocx(filename, mime)) {
    const text = await extractOfficeText(raw, "docx");
    return { text, method: text ? "docx" : "none" };
  }
  if (looksLikeXlsx(filename, mime)) {
    const text = await extractOfficeText(raw, "xlsx");
    return { text, method: text ? "xlsx" : "none" };
  }
  if (looksLikePdf(filename, mime)) {
    const text = await extractPdfText(env, input.bytes, mime || "application/pdf");
    return { text, method: text ? "pdf_ocr" : "none" };
  }
  if (looksLikeRasterImage(filename, mime)) {
    const text = await extractPdfText(env, input.bytes, mime || "image/jpeg");
    return { text, method: text ? "pdf_ocr" : "none" };
  }
  if (raw.length && raw[0] === 0x50 && raw[1] === 0x4b) {
    const docx = await extractOfficeText(raw, "docx");
    if (docx) return { text: docx, method: "docx" };
    const xlsx = await extractOfficeText(raw, "xlsx");
    if (xlsx) return { text: xlsx, method: "xlsx" };
  }
  return { text: "", method: "none" };
}

export function chunkExtractedText(
  documentId: string,
  text: string,
): Array<{ id: string; text: string; index: number }> {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const blocks = clean
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length >= 20);
  const units = blocks.length >= 2 ? blocks : splitByLength(clean, 900);
  return units.map((block, index) => ({
    id: `${documentId}:c${index}`,
    text: block,
    index,
  }));
}

function splitByLength(text: string, size: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    out.push(text.slice(start, start + size).trim());
    start += size;
  }
  return out.filter(Boolean);
}
