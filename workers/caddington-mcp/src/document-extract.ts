import type { Env } from "./db";

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function isPlainTextDocument(mimeType: string, filename: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();
  return (
    lowerMime.startsWith("text/") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".json")
  );
}

export function isWorkersAiConvertible(mimeType: string, filename: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();
  return (
    lowerMime === "application/pdf" ||
    lowerName.endsWith(".pdf") ||
    lowerMime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx") ||
    lowerMime === "application/msword" ||
    lowerName.endsWith(".doc") ||
    lowerMime === "application/vnd.oasis.opendocument.text" ||
    lowerName.endsWith(".odt") ||
    lowerMime === "application/rtf" ||
    lowerName.endsWith(".rtf") ||
    lowerMime === "text/html" ||
    lowerName.endsWith(".html") ||
    lowerName.endsWith(".htm")
  );
}

export async function extractDocumentText(
  env: Env,
  bytes: ArrayBuffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const name = basename(filename);

  if (isPlainTextDocument(mimeType, name)) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  if (!isWorkersAiConvertible(mimeType, name)) {
    throw new Error(
      `Unsupported document type: ${mimeType || name}. Supported: plain text, PDF, Word (.docx/.doc), RTF, ODT, HTML.`
    );
  }

  const blob = new Blob([bytes], {
    type: mimeType || "application/octet-stream",
  });

  const result = await env.AI.toMarkdown(
    { name, blob },
    {
      conversionOptions: {
        output: { format: "text" },
        pdf: { metadata: false, images: { convert: false } },
        docx: { images: { convert: false } },
      },
    }
  );

  if (result.format === "error") {
    throw new Error(`Document conversion failed: ${result.error}`);
  }

  const text = result.data.replace(/\r\n/g, "\n").trim();
  if (!text) {
    throw new Error("No extractable text in document after conversion.");
  }

  return text;
}
