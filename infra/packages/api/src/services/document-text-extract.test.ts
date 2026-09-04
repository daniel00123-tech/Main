import { describe, expect, it } from "vitest";
import {
  extractDocxXmlText,
  extractXlsxSharedStrings,
  extractOfficeText,
  chunkExtractedText,
} from "./document-text-extract";

function storedZip(name: string, body: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const data = new TextEncoder().encode(body);
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
  return header;
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
