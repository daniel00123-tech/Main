import { describe, expect, it } from "vitest";
import {
  extractDocxXmlText,
  extractXlsxSharedStrings,
  extractOfficeText,
  extractXlsxWorkbook,
  extractDocumentBytes,
  chunkExtractedText,
} from "./document-text-extract";

function storedZip(name: string, body: string): Uint8Array {
  return storedZipEntries([{ name, body }]);
}

function storedZipEntries(files: Array<{ name: string; body: string }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const data = new TextEncoder().encode(file.body);
    const header = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    header.set(data, 30 + nameBytes.length);
    chunks.push(header);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("office text extraction", () => {
  it("extracts Word paragraph text from document.xml", () => {
    const xml = `<w:document><w:body>
      <w:p><w:r><w:t>Health and Safety Policy</w:t></w:r></w:p>
      <w:p><w:r><w:t>Employees must report incidents within 24 hours.</w:t></w:r></w:p>
      <w:tbl><w:tblPr><w:tblW w:w="10065" w:type="dxa" /></w:tblPr></w:tbl>
    </w:body></w:document>`;
    expect(extractDocxXmlText(xml)).toContain("Health and Safety Policy");
    expect(extractDocxXmlText(xml)).toContain("report incidents");
    expect(extractDocxXmlText(xml)).not.toMatch(/<w:/);
  });

  it("extracts Excel shared strings", () => {
    const xml = `<sst><si><t>Customer</t></si><si><t>Acme Ltd</t></si></sst>`;
    expect(extractXlsxSharedStrings(xml)).toBe("Customer\nAcme Ltd");
  });

  it("unzips a stored docx document.xml", async () => {
    const xml = `<w:p><w:r><w:t>Sunrise PQQ Master</w:t></w:r></w:p>`;
    const bytes = storedZip("word/document.xml", xml);
    expect(await extractOfficeText(bytes, "docx")).toBe("Sunrise PQQ Master");
  });

  it("chunks extracted text without inventing extra documents", () => {
    const text = "Purpose\n\nThis policy covers site safety.\n\nIncidents must be logged on the same day.";
    const chunks = chunkExtractedText("01ABC", text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((chunk) => chunk.id.startsWith("01ABC:"))).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join(" ")).not.toMatch(/invent|guess/i);
  });
});

describe("xlsx workbook extraction", () => {
  const env = {} as import("../env").Env;

  it("extracts a normal single-sheet workbook with shared strings", async () => {
    const bytes = storedZipEntries([
      {
        name: "xl/workbook.xml",
        body: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Suppliers" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        body: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      { name: "xl/sharedStrings.xml", body: `<sst><si><t>Supplier</t></si><si><t>Acme Ltd</t></si></sst>` },
      {
        name: "xl/worksheets/sheet1.xml",
        body: `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>`,
      },
    ]);
    const extracted = await extractXlsxWorkbook(bytes);
    expect(extracted.status).toBe("ok");
    expect(extracted.text).toContain("Sheet: Suppliers");
    expect(extracted.text).toContain("Acme Ltd");
    expect(chunkExtractedText("doc1", extracted.text).length).toBeGreaterThan(0);
  });

  it("extracts multiple sheets including a hidden sheet", async () => {
    const bytes = storedZipEntries([
      {
        name: "xl/workbook.xml",
        body: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/><sheet name="HiddenRates" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        body: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        body: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>On call</t></is></c></row></sheetData></worksheet>`,
      },
      {
        name: "xl/worksheets/sheet2.xml",
        body: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Holiday rate</t></is></c></row></sheetData></worksheet>`,
      },
    ]);
    const extracted = await extractXlsxWorkbook(bytes);
    expect(extracted.sheetCount).toBe(2);
    expect(extracted.text).toContain("On call");
    expect(extracted.text).toContain("Holiday rate");
    expect(extracted.text).toMatch(/HiddenRates \(hidden\)/);
  });

  it("keeps number cells from a mostly empty workbook", async () => {
    const bytes = storedZipEntries([
      {
        name: "xl/workbook.xml",
        body: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sparse" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      { name: "xl/_rels/workbook.xml.rels", body: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      {
        name: "xl/worksheets/sheet1.xml",
        body: `<worksheet><sheetData><row r="8"><c r="C8"><v>19.5</v></c></row></sheetData></worksheet>`,
      },
    ]);
    const extracted = await extractXlsxWorkbook(bytes);
    expect(extracted.status).toBe("ok");
    expect(extracted.text).toContain("19.5");
  });

  it("uses cached formula values when present", async () => {
    const bytes = storedZipEntries([
      {
        name: "xl/workbook.xml",
        body: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Calc" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      { name: "xl/_rels/workbook.xml.rels", body: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      {
        name: "xl/worksheets/sheet1.xml",
        body: `<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(B1:B2)</f><v>88</v></c></row></sheetData></worksheet>`,
      },
    ]);
    const extracted = await extractXlsxWorkbook(bytes);
    expect(extracted.status).toBe("ok");
    expect(extracted.text).toContain("88");
  });

  it("returns empty for a genuinely empty workbook", async () => {
    const bytes = storedZipEntries([
      {
        name: "xl/workbook.xml",
        body: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Empty" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      { name: "xl/_rels/workbook.xml.rels", body: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: "xl/worksheets/sheet1.xml", body: `<worksheet><sheetData></sheetData></worksheet>` },
    ]);
    const extracted = await extractXlsxWorkbook(bytes);
    expect(extracted.status).toBe("empty");
    const documented = await extractDocumentBytes(env, { bytes: bytes.buffer, filename: "empty.xlsx" });
    expect(documented.failureCode).toBe("EMPTY_WORKBOOK");
  });

  it("returns corrupt for a malformed workbook", async () => {
    const extracted = await extractXlsxWorkbook(new Uint8Array([1, 2, 3, 4, 5]));
    expect(extracted.status).toBe("corrupt");
    const documented = await extractDocumentBytes(env, { bytes: new Uint8Array([1, 2, 3, 4]).buffer, filename: "bad.xlsx" });
    expect(documented.failureCode).toBe("CORRUPT_WORKBOOK");
  });

  it("does not expose raw binary in extracted text", async () => {
    const bytes = storedZipEntries([
      {
        name: "xl/workbook.xml",
        body: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Safe" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      { name: "xl/_rels/workbook.xml.rels", body: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      {
        name: "xl/worksheets/sheet1.xml",
        body: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Readable business row</t></is></c></row></sheetData></worksheet>`,
      },
    ]);
    const text = await extractOfficeText(bytes, "xlsx");
    expect(text).toContain("Readable business row");
    expect(text).not.toMatch(/PK\u0003\u0004/);
  });
});
