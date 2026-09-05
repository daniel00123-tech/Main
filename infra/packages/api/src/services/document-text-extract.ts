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
  failureCode?: string;
  failureReason?: string;
};

export type XlsxExtractResult = {
  text: string;
  status: "ok" | "empty" | "corrupt";
  reason: string | null;
  sheetCount: number;
  cellCount: number;
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

export type ZipEntry = { name: string; bytes: Uint8Array };

async function inflateEntry(method: number, payload: Uint8Array): Promise<Uint8Array | null> {
  if (method === 0) return payload;
  if (method === 8) {
    try {
      return await inflateRaw(payload);
    } catch {
      return null;
    }
  }
  return null;
}

async function unzipLocalSequential(bytes: Uint8Array): Promise<ZipEntry[] | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (readU32(view, offset) !== 0x04034b50) break;
    const method = readU16(view, offset + 8);
    const flags = readU16(view, offset + 6);
    const compressedSize = readU32(view, offset + 18);
    const nameLen = readU16(view, offset + 26);
    const extraLen = readU16(view, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) return entries.length ? entries : null;
    const name = decodeUtf8(bytes.subarray(nameStart, nameEnd));
    const dataStart = nameEnd + extraLen;
    if (flags & 0x8) {
      // Data descriptor: local compressed size is unreliable. Stop sequential parse.
      break;
    }
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) return entries.length ? entries : null;
    const inflated = await inflateEntry(method, bytes.subarray(dataStart, dataEnd));
    if (inflated) entries.push({ name, bytes: inflated });
    offset = dataEnd;
  }
  return entries.length ? entries : null;
}

export async function unzipAll(bytes: Uint8Array): Promise<ZipEntry[] | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let index = bytes.length - 22; index >= min; index -= 1) {
    if (readU32(view, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return unzipLocalSequential(bytes);
  const total = readU16(view, eocd + 10);
  const cdOffset = readU32(view, eocd + 16);
  const entries: ZipEntry[] = [];
  let offset = cdOffset;
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > bytes.length || readU32(view, offset) !== 0x02014b50) {
      return entries.length ? entries : unzipLocalSequential(bytes);
    }
    const method = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const nameLen = readU16(view, offset + 28);
    const extraLen = readU16(view, offset + 30);
    const commentLen = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const name = decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLen));
    if (localOffset + 30 > bytes.length) {
      offset += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    const localNameLen = readU16(view, localOffset + 26);
    const localExtra = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtra;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      offset += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    const inflated = await inflateEntry(method, bytes.subarray(dataStart, dataEnd));
    if (inflated && !name.endsWith("/")) entries.push({ name, bytes: inflated });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries.length ? entries : unzipLocalSequential(bytes);
}

export async function unzipEntry(bytes: Uint8Array, wanted: string): Promise<Uint8Array | null> {
  const entries = await unzipAll(bytes);
  return entries?.find((entry) => entry.name === wanted)?.bytes ?? null;
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
  const workbook = await extractXlsxWorkbook(bytes);
  if (workbook.status === "ok") return workbook.text;
  const shared = await unzipEntry(bytes, "xl/sharedStrings.xml");
  if (shared) {
    const fromShared = extractXlsxSharedStrings(decodeUtf8(shared));
    if (fromShared) return fromShared;
  }
  const sheet = await unzipEntry(bytes, "xl/worksheets/sheet1.xml");
  if (!sheet) return "";
  return xmlTextContent(decodeUtf8(sheet), "v").join("\n").trim();
}

function columnLabel(cellRef: string): string {
  const match = cellRef.match(/^([A-Z]+)/i);
  return match?.[1]?.toUpperCase() ?? "";
}

function parseSharedStringTable(xml: string): string[] {
  const items = xml.split(/<\/si>/i);
  const values: string[] = [];
  for (const item of items) {
    if (!/<si[\s>]/i.test(item) && !/<t[\s>]/i.test(item)) continue;
    values.push(xmlTextContent(`${item}</t>`, "t").join("").trim());
  }
  return values;
}

function parseWorkbookSheets(xml: string): Array<{ name: string; relId: string; hidden: boolean }> {
  const sheets: Array<{ name: string; relId: string; hidden: boolean }> = [];
  for (const match of xml.matchAll(/<sheet\b([^>]+)\/>/gi)) {
    const attrs = match[1] ?? "";
    const name = /name="([^"]+)"/i.exec(attrs)?.[1] ?? "";
    const relId = /r:id="([^"]+)"/i.exec(attrs)?.[1] ?? /id="([^"]+)"/i.exec(attrs)?.[1] ?? "";
    const hidden = /state="(hidden|veryHidden)"/i.test(attrs);
    if (name) sheets.push({ name: decodeXmlEntities(name), relId, hidden });
  }
  return sheets;
}

function parseWorkbookRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]+)\/>/gi)) {
    const attrs = match[1] ?? "";
    const id = /Id="([^"]+)"/i.exec(attrs)?.[1];
    const target = /Target="([^"]+)"/i.exec(attrs)?.[1];
    if (id && target) map.set(id, target.replace(/^\//, ""));
  }
  return map;
}

function extractXlsxCellValue(cellXml: string, shared: string[]): string {
  const type = /t="([^"]+)"/i.exec(cellXml)?.[1] ?? "";
  if (type === "inlineStr" || type === "str") {
    return xmlTextContent(cellXml, "t").join("").trim();
  }
  const cached = xmlTextContent(cellXml, "v")[0] ?? "";
  if (type === "s") {
    const index = Number(cached);
    return Number.isInteger(index) && shared[index] != null ? shared[index] : "";
  }
  if (type === "b") return cached === "1" ? "TRUE" : cached === "0" ? "FALSE" : cached;
  return cached.trim();
}

function extractXlsxSheetText(xml: string, shared: string[]): { lines: string[]; cellCount: number } {
  const lines: string[] = [];
  let cellCount = 0;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = cellMatch[1] ?? "";
      const ref = /r="([^"]+)"/i.exec(attrs)?.[1] ?? "";
      const value = extractXlsxCellValue(`<c ${attrs}>${cellMatch[2]}</c>`, shared);
      if (!value) continue;
      cellCount += 1;
      const col = columnLabel(ref);
      cells.push(col ? `${col}: ${value}` : value);
    }
    if (cells.length) lines.push(cells.join(" | "));
  }
  return { lines, cellCount };
}

export async function extractXlsxWorkbook(bytes: Uint8Array): Promise<XlsxExtractResult> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return { text: "", status: "corrupt", reason: "not_zip", sheetCount: 0, cellCount: 0 };
  }
  const entries = await unzipAll(bytes);
  if (!entries) return { text: "", status: "corrupt", reason: "zip_unreadable", sheetCount: 0, cellCount: 0 };
  const files = new Map(entries.map((entry) => [entry.name.replace(/^\/+/, ""), entry.bytes]));
  const workbookXml = files.get("xl/workbook.xml");
  const sharedXml = files.get("xl/sharedStrings.xml");
  const shared = sharedXml ? parseSharedStringTable(decodeUtf8(sharedXml)) : [];
  const blocks: string[] = [];
  let cellCount = 0;
  let sheetCount = 0;

  if (workbookXml) {
    const sheets = parseWorkbookSheets(decodeUtf8(workbookXml));
    const rels = files.get("xl/_rels/workbook.xml.rels");
    const relMap = rels ? parseWorkbookRels(decodeUtf8(rels)) : new Map<string, string>();
    for (const sheet of sheets) {
      const target = relMap.get(sheet.relId) ?? "";
      const path = target
        ? target.startsWith("xl/")
          ? target
          : `xl/${target.replace(/^\.\//, "")}`
        : "";
      const sheetBytes =
        (path && files.get(path)) ||
        files.get(`xl/worksheets/sheet${sheetCount + 1}.xml`) ||
        [...files.entries()].find(([name]) => name.startsWith("xl/worksheets/") && name.endsWith(".xml"))?.[1];
      if (!sheetBytes) continue;
      const extracted = extractXlsxSheetText(decodeUtf8(sheetBytes), shared);
      sheetCount += 1;
      cellCount += extracted.cellCount;
      if (!extracted.lines.length) continue;
      const hidden = sheet.hidden ? " (hidden)" : "";
      blocks.push(`# Sheet: ${sheet.name}${hidden}\n${extracted.lines.join("\n")}`);
    }
  } else {
    const sheetEntries = [...files.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
    for (const [name, sheetBytes] of sheetEntries) {
      const extracted = extractXlsxSheetText(decodeUtf8(sheetBytes), shared);
      sheetCount += 1;
      cellCount += extracted.cellCount;
      if (extracted.lines.length) blocks.push(`# Sheet: ${name}\n${extracted.lines.join("\n")}`);
    }
    if (!sheetEntries.length && shared.length) {
      const labels = shared.filter(Boolean);
      if (labels.length) {
        cellCount = labels.length;
        blocks.push(labels.join("\n"));
      }
    }
  }

  const text = blocks.join("\n\n").trim();
  if (!text || cellCount === 0) {
    return { text: "", status: "empty", reason: "no_cell_values", sheetCount, cellCount };
  }
  return { text, status: "ok", reason: null, sheetCount, cellCount };
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
    const workbook = await extractXlsxWorkbook(raw);
    if (workbook.status === "corrupt") {
      return { text: "", method: "none", failureCode: "CORRUPT_WORKBOOK", failureReason: workbook.reason ?? "unreadable xlsx" };
    }
    if (workbook.status === "empty") {
      return { text: "", method: "none", failureCode: "EMPTY_WORKBOOK", failureReason: workbook.reason ?? "no cell values" };
    }
    return { text: workbook.text, method: "xlsx" };
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
  if (/^# Sheet:/m.test(clean)) {
    return splitByLength(clean, 900)
      .filter(Boolean)
      .map((block, index) => ({ id: `${documentId}:c${index}`, text: block, index }));
  }
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
