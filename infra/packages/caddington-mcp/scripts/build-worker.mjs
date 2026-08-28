import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  XERO_INJECT_BEGIN,
  XERO_INJECT_END,
  assertNoDuplicateXeroSymbols,
  stripXeroInjection,
} from "./strip-xero-inject.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const basePath = path.join(pkgRoot, "vendor/base.worker.js");
const distDir = path.join(pkgRoot, "dist");
const xeroBundlePath = path.join(distDir, "xero-inject.js");
const outPath = path.join(distDir, "worker.js");

if (!fs.existsSync(basePath)) {
  console.error("Missing vendor/base.worker.js — run npm run download-base first");
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(pkgRoot, "src/xero/inject-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: xeroBundlePath,
  alias: {
    "@infra/shared": path.join(pkgRoot, "../shared/src/index.ts"),
    "@infra/xero-core": path.join(pkgRoot, "../xero-core/src/index.ts"),
  },
  external: [],
  logLevel: "info",
});

const xeroBundle = fs.readFileSync(xeroBundlePath, "utf8");
const rawBase = fs.readFileSync(basePath, "utf8");
let base = stripXeroInjection(rawBase);

const injectCall =
  "  registerXeroReadTools(server, env22, external_exports);\n  registerXeroWriteTools(server, env22, external_exports);\n  return server;\n}\n__name(createCaddingtonMcpServer";
const createServerReturn =
  "  return server;\n}\n__name(createCaddingtonMcpServer";

if (!/\bregisterXeroReadTools\s*\(\s*server/.test(base)) {
  if (!base.includes(createServerReturn)) {
    throw new Error("Unable to locate createCaddingtonMcpServer injection point in base worker");
  }
  base = base.replace(createServerReturn, injectCall);
}

const fetchPatchTarget =
  "      const handler = createStatelessMcpHandler(\n        () => createCaddingtonMcpServer(env22),\n        { route: \"/mcp\", legacy: \"stateless\" }\n      );\n      return handler(request, env22, ctx);";
const fetchPatchReplacement = `      const xeroContextHeader = request.headers.get("X-Infra-Xero-Context");
      if (xeroContextHeader) {
        try {
          env22.__infraXeroContext = JSON.parse(atob(xeroContextHeader));
        } catch {
          // ignore malformed internal execution context
        }
      }
      const handler = createStatelessMcpHandler(
        () => createCaddingtonMcpServer(env22),
        { route: "/mcp", legacy: "stateless" }
      );
      return handler(request, env22, ctx);`;

if (!base.includes('request.headers.get("X-Infra-Xero-Context")')) {
  if (!base.includes(fetchPatchTarget)) {
    throw new Error("Unable to locate MCP fetch handler injection point in base worker");
  }
  base = base.replace(fetchPatchTarget, fetchPatchReplacement);
}

const adminAuthTrimTarget =
  'return header.slice("Bearer ".length) === expected;';
const adminAuthTrimReplacement =
  'const received = header.slice("Bearer ".length).trim();\n  return received === String(expected).trim();';
if (!base.includes("received === String(expected).trim()")) {
  if (!base.includes(adminAuthTrimTarget)) {
    throw new Error("Unable to locate checkAdminAuth comparison in base worker");
  }
  base = base.replace(adminAuthTrimTarget, adminAuthTrimReplacement);
}

const uploadIdempotencyMarker = 'action: "existing"';
const uploadIdempotencyTarget = `  const insert = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    \`INSERT INTO knowledge_documents (external_id, title, description, r2_key, mime_type, byte_size, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)\`
  ).bind(`;
const uploadIdempotencyReplacement = `  const existingDoc = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT id FROM knowledge_documents WHERE external_id = ? LIMIT 1"
  ).bind(externalId).first();
  if (existingDoc?.id) {
    return json2({
      ok: true,
      documentId: existingDoc.id,
      externalId,
      r2Key: null,
      byteSize: bytes.byteLength,
      action: "existing",
      indexUrl: \`/admin/knowledge/\${existingDoc.id}/index\`
    });
  }
  const insert = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    \`INSERT INTO knowledge_documents (external_id, title, description, r2_key, mime_type, byte_size, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)\`
  ).bind(`;
if (!base.includes(uploadIdempotencyMarker)) {
  if (!base.includes(uploadIdempotencyTarget)) {
    throw new Error("Unable to locate uploadKnowledgeDocument insert in base worker");
  }
  base = base.replace(uploadIdempotencyTarget, uploadIdempotencyReplacement);
}

const knowledgeVisibilityMarker = "deactivateKnowledgeDocument";
if (!base.includes(knowledgeVisibilityMarker)) {
  const visibilityHelpersTarget = "async function handleAdminRequest(request, env22, url2) {";
  const visibilityHelpersReplacement = `async function deactivateKnowledgeDocument(env22, documentId) {
  const doc = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT id, external_id, status FROM knowledge_documents WHERE id = ?"
  ).bind(documentId).first();
  if (!doc?.id) throw new Error("Document not found");
  const chunks = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT vector_id FROM knowledge_chunks WHERE document_id = ?"
  ).bind(documentId).all();
  const vectorIds = (chunks.results ?? []).map((row) => row.vector_id).filter(Boolean);
  if (vectorIds.length > 0 && env22.CADDINGTON_KNOWLEDGE_INDEX?.deleteByIds) {
    await env22.CADDINGTON_KNOWLEDGE_INDEX.deleteByIds(vectorIds);
  }
  await deleteDocumentFtsRows(env22, documentId);
  await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "UPDATE knowledge_documents SET status = 'archived', updated_at = datetime('now') WHERE id = ?"
  ).bind(documentId).run();
  clearSearchCache();
  return { ok: true, documentId, previousStatus: doc.status };
}
__name(deactivateKnowledgeDocument, "deactivateKnowledgeDocument");
async function reactivateKnowledgeDocument(env22, documentId) {
  const doc = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT id, status FROM knowledge_documents WHERE id = ?"
  ).bind(documentId).first();
  if (!doc?.id) throw new Error("Document not found");
  const chunkCount = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE document_id = ?"
  ).bind(documentId).first();
  if (Number(chunkCount?.cnt ?? 0) > 0) {
    const result = await indexKnowledgeDocument(env22, documentId);
    return { ok: true, documentId, status: "indexed", ...result };
  }
  await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "UPDATE knowledge_documents SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
  ).bind(documentId).run();
  clearSearchCache();
  return { ok: true, documentId, status: "pending" };
}
__name(reactivateKnowledgeDocument, "reactivateKnowledgeDocument");
async function handleAdminRequest(request, env22, url2) {`;
  if (!base.includes(visibilityHelpersTarget)) {
    throw new Error("Unable to locate handleAdminRequest for visibility helpers");
  }
  base = base.replace(visibilityHelpersTarget, visibilityHelpersReplacement);

  const visibilityRoutesTarget = `  return json2({ error: "Not Found" }, 404);
}
__name(handleAdminRequest, "handleAdminRequest");`;
  const visibilityRoutesReplacement = `  const deactivateMatch = url2.pathname.match(/^\\/admin\\/knowledge\\/(\\d+)\\/deactivate$/);
  if (deactivateMatch && request.method === "POST") {
    const documentId = Number(deactivateMatch[1]);
    try {
      const result = await deactivateKnowledgeDocument(env22, documentId);
      return json2(result);
    } catch (error53) {
      const message = error53 instanceof Error ? error53.message : String(error53);
      return json2({ error: message }, 400);
    }
  }
  const reactivateMatch = url2.pathname.match(/^\\/admin\\/knowledge\\/(\\d+)\\/reactivate$/);
  if (reactivateMatch && request.method === "POST") {
    const documentId = Number(reactivateMatch[1]);
    try {
      const result = await reactivateKnowledgeDocument(env22, documentId);
      return json2(result);
    } catch (error53) {
      const message = error53 instanceof Error ? error53.message : String(error53);
      return json2({ error: message }, 400);
    }
  }
  return json2({ error: "Not Found" }, 404);
}
__name(handleAdminRequest, "handleAdminRequest");`;
  if (!base.includes(visibilityRoutesTarget)) {
    throw new Error("Unable to locate handleAdminRequest footer for visibility routes");
  }
  base = base.replace(visibilityRoutesTarget, visibilityRoutesReplacement);
}

const indexBatchMarker = "indexChunkOffset === 0";
if (!base.includes(indexBatchMarker)) {
  const indexDeleteTarget = `    if (chunks.length === 0) {
      throw new Error("No extractable text in document.");
    }
    await env22.CADDINGTON_BUSINESS_DATA.prepare(
      "DELETE FROM knowledge_chunks WHERE document_id = ?"
    ).bind(documentId).run();
    await deleteDocumentFtsRows(env22, documentId);`;
  const indexDeleteReplacement = `    if (chunks.length === 0) {
      throw new Error("No extractable text in document.");
    }
    const MAX_CHUNKS_PER_INDEX_CALL = 8;
    const progressRow = await env22.CADDINGTON_BUSINESS_DATA.prepare(
      "SELECT metadata FROM knowledge_documents WHERE id = ?"
    ).bind(documentId).first();
    let indexChunkOffset = 0;
    try {
      const progressMeta = progressRow?.metadata ? JSON.parse(progressRow.metadata) : {};
      indexChunkOffset = Number(progressMeta.indexChunkOffset ?? 0);
    } catch {
      indexChunkOffset = 0;
    }
    const batchEnd = Math.min(chunks.length, indexChunkOffset + MAX_CHUNKS_PER_INDEX_CALL);
    if (indexChunkOffset === 0) {
      await env22.CADDINGTON_BUSINESS_DATA.prepare(
        "DELETE FROM knowledge_chunks WHERE document_id = ?"
      ).bind(documentId).run();
      await deleteDocumentFtsRows(env22, documentId);
    }`;
  if (!base.includes(indexDeleteTarget)) {
    throw new Error("Unable to locate indexKnowledgeDocument delete block in base worker");
  }
  base = base.replace(indexDeleteTarget, indexDeleteReplacement);

  const indexLoopTarget = `    for (let i = 0; i < chunks.length; i++) {
      const { content, metadata } = chunks[i];`;
  const indexLoopReplacement = `    for (let i = indexChunkOffset; i < batchEnd; i++) {
      const { content, metadata } = chunks[i];`;
  if (!base.includes(indexLoopTarget)) {
    throw new Error("Unable to locate indexKnowledgeDocument chunk loop in base worker");
  }
  base = base.replace(indexLoopTarget, indexLoopReplacement);

  const indexCompleteTarget = `    if (vectors.length > 0) {
      await env22.CADDINGTON_KNOWLEDGE_INDEX.upsert(vectors);
    }
    await env22.CADDINGTON_BUSINESS_DATA.prepare(
      \`UPDATE knowledge_documents SET status = 'indexed', indexed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?\`
    ).bind(documentId).run();
    clearSearchCache();
    await completeKnowledgeImportLog(env22, logId, "completed", indexed);
    log32("info", "knowledge_document_indexed", {
      documentId,
      format: extracted.format,
      chunks: indexed
    });
    return { chunksIndexed: indexed };`;
  const indexCompleteReplacement = `    if (vectors.length > 0) {
      await env22.CADDINGTON_KNOWLEDGE_INDEX.upsert(vectors);
    }
    if (batchEnd < chunks.length) {
      await mergeDocumentMetadata(env22, documentId, { indexChunkOffset: batchEnd });
      await env22.CADDINGTON_BUSINESS_DATA.prepare(
        \`UPDATE knowledge_documents SET status = 'pending', updated_at = datetime('now') WHERE id = ?\`
      ).bind(documentId).run();
      log32("info", "knowledge_document_index_partial", {
        documentId,
        indexedThisBatch: indexed,
        continueAt: batchEnd,
        totalChunks: chunks.length
      });
      return { chunksIndexed: indexed, partial: true, continueAt: batchEnd, totalChunks: chunks.length };
    }
    await mergeDocumentMetadata(env22, documentId, { indexChunkOffset: null });
    await env22.CADDINGTON_BUSINESS_DATA.prepare(
      \`UPDATE knowledge_documents SET status = 'indexed', indexed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?\`
    ).bind(documentId).run();
    clearSearchCache();
    await completeKnowledgeImportLog(env22, logId, "completed", indexed);
    log32("info", "knowledge_document_indexed", {
      documentId,
      format: extracted.format,
      chunks: indexed
    });
    return { chunksIndexed: indexed, partial: false };`;
  if (!base.includes(indexCompleteTarget)) {
    throw new Error("Unable to locate indexKnowledgeDocument completion block in base worker");
  }
  base = base.replace(indexCompleteTarget, indexCompleteReplacement);

  const indexRouteTarget = `  if (indexMatch && request.method === "POST") {
    const documentId = Number(indexMatch[1]);
    try {
      const result = await indexKnowledgeDocument(env22, documentId);
      return json2({ ok: true, documentId, ...result });
    } catch (error53) {
      const message = error53 instanceof Error ? error53.message : String(error53);
      return json2({ error: message }, 400);
    }
  }`;
  const indexRouteReplacement = `  if (indexMatch && request.method === "POST") {
    const documentId = Number(indexMatch[1]);
    try {
      const result = await indexKnowledgeDocument(env22, documentId);
      if (result?.partial) {
        const continueUrl = new URL(request.url);
        ctx.waitUntil(
          fetch(continueUrl.toString(), {
            method: "POST",
            headers: { Authorization: request.headers.get("Authorization") ?? "" }
          })
        );
      }
      return json2({ ok: true, documentId, ...result });
    } catch (error53) {
      const message = error53 instanceof Error ? error53.message : String(error53);
      return json2({ error: message }, 400);
    }
  }`;
  if (!base.includes('result?.partial')) {
    if (!base.includes(indexRouteTarget)) {
      throw new Error("Unable to locate admin knowledge index route in base worker");
    }
    base = base.replace(indexRouteTarget, indexRouteReplacement);
  }

  const adminHandlerSigTarget = "async function handleAdminRequest(request, env22, url2) {";
  const adminHandlerSigReplacement = "async function handleAdminRequest(request, env22, url2, ctx) {";
  if (!base.includes(adminHandlerSigReplacement)) {
    if (!base.includes(adminHandlerSigTarget)) {
      throw new Error("Unable to locate handleAdminRequest signature in base worker");
    }
    base = base.replace(adminHandlerSigTarget, adminHandlerSigReplacement);
  }

  const adminHandlerCallTarget = "return handleAdminRequest(request, env22, url2);";
  const adminHandlerCallReplacement = "return handleAdminRequest(request, env22, url2, ctx);";
  if (!base.includes(adminHandlerCallReplacement)) {
    if (!base.includes(adminHandlerCallTarget)) {
      throw new Error("Unable to locate handleAdminRequest call site in base worker");
    }
    base = base.replace(adminHandlerCallTarget, adminHandlerCallReplacement);
  }
}

const pdfQualityMarker = "assessPdfExtractionQuality";
if (!base.includes(pdfQualityMarker)) {
  const pdfOcrTarget = `var PDF_OCR_MIN_CHARS = 40;
function pdfRequiresOcr(text) {
  return meaningfulTextLength(text) < PDF_OCR_MIN_CHARS;
}
__name(pdfRequiresOcr, "pdfRequiresOcr");
__name2(pdfRequiresOcr, "pdfRequiresOcr");`;
  const pdfOcrReplacement = `var PDF_OCR_MIN_CHARS = 40;
var PDF_PAGE_MARKER_RE = /^(#{1,6}\\s+)?page\\s+\\d+\\s*$/i;
function stripPdfPageMarkers(text) {
  return text.split("\\n").filter((line) => !PDF_PAGE_MARKER_RE.test(line.trim())).join("\\n").replace(/^(#{1,6}\\s+)(.+)$/gm, "$2").trim();
}
__name(stripPdfPageMarkers, "stripPdfPageMarkers");
__name2(stripPdfPageMarkers, "stripPdfPageMarkers");
function assessPdfExtractionQuality(segments, rawMarkdown) {
  const pageSegments = segments.filter((s) => s.metadata?.page != null);
  const units = pageSegments.length > 0 ? pageSegments : segments;
  const pageCount = pageSegments.length > 0 ? pageSegments.length : Math.max(units.length, 1);
  let pagesWithText = 0;
  for (const segment of units) {
    if (meaningfulTextLength(stripPdfPageMarkers(segment.text)) >= 40) pagesWithText++;
  }
  const joined = segments.map((s) => s.text).join("\\n\\n");
  const extractedCharacterCount = meaningfulTextLength(joined);
  const substantiveCharacterCount = meaningfulTextLength(stripPdfPageMarkers(joined));
  let extractionQuality = "good";
  let fallbackRequired = false;
  let requiresOcr = false;
  if (substantiveCharacterCount < 40) {
    requiresOcr = true;
    extractionQuality = "requires_ocr";
    fallbackRequired = true;
  } else if (pageCount >= 2 && pagesWithText / pageCount < 0.5) {
    requiresOcr = true;
    extractionQuality = "heading_only";
    fallbackRequired = true;
  } else if (substantiveCharacterCount < 80 && pageCount >= 2) {
    requiresOcr = true;
    extractionQuality = "poor";
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
    fallbackOutcome: fallbackRequired ? "ocr_not_available" : "not_required"
  };
}
__name(assessPdfExtractionQuality, "assessPdfExtractionQuality");
__name2(assessPdfExtractionQuality, "assessPdfExtractionQuality");
function pdfRequiresOcr(text, segments) {
  const assessment = assessPdfExtractionQuality(segments ?? [{ text }], text);
  return assessment.requiresOcr;
}
__name(pdfRequiresOcr, "pdfRequiresOcr");
__name2(pdfRequiresOcr, "pdfRequiresOcr");`;
  if (!base.includes(pdfOcrTarget)) {
    throw new Error("Unable to locate pdfRequiresOcr block in base worker");
  }
  base = base.replace(pdfOcrTarget, pdfOcrReplacement);

  const extractPdfTarget = `  const rawText = segments.map((s) => s.text).join("\\n\\n");
  const requiresOcr = resolvedFormat === "pdf" && pdfRequiresOcr(rawText || markdown);
  if (!rawText && !requiresOcr) {
    throw new Error("No extractable text in document after conversion.");
  }
  return {
    format: resolvedFormat === "other" ? "docx" : resolvedFormat,
    segments,
    requiresOcr,
    rawTextLength: rawText.length
  };`;
  const extractPdfReplacement = `  const rawText = segments.map((s) => s.text).join("\\n\\n");
  let requiresOcr = resolvedFormat === "pdf" && pdfRequiresOcr(rawText || markdown, segments);
  let extractionMetrics = null;
  if (resolvedFormat === "pdf") {
    extractionMetrics = assessPdfExtractionQuality(segments, markdown);
    requiresOcr = extractionMetrics.requiresOcr;
  }
  if (!rawText && !requiresOcr) {
    throw new Error("No extractable text in document after conversion.");
  }
  return {
    format: resolvedFormat === "other" ? "docx" : resolvedFormat,
    segments,
    requiresOcr,
    rawTextLength: rawText.length,
    extractionMetrics
  };`;
  if (!base.includes(extractPdfTarget)) {
    throw new Error("Unable to locate extractDocument PDF return block in base worker");
  }
  base = base.replace(extractPdfTarget, extractPdfReplacement);

  const indexMetaTarget = `    const documentMetaPatch = {
      sourceFormat: extracted.format,
      rawTextLength: extracted.rawTextLength
    };`;
  const indexMetaReplacement = `    const documentMetaPatch = {
      sourceFormat: extracted.format,
      rawTextLength: extracted.rawTextLength
    };
    if (extracted.extractionMetrics) {
      Object.assign(documentMetaPatch, extracted.extractionMetrics);
    }`;
  if (!base.includes("extracted.extractionMetrics")) {
    if (!base.includes(indexMetaTarget)) {
      throw new Error("Unable to locate indexKnowledgeDocument metadata patch in base worker");
    }
    base = base.replace(indexMetaTarget, indexMetaReplacement);
  }

  const indexOcrReturnTarget = `      const ocrMessage = "PDF has little or no extractable text. Document marked as requires_ocr.";
      await completeKnowledgeImportLog(env22, logId, "failed", 0, ocrMessage);
      throw new RequiresOcrError(ocrMessage);`;
  const indexOcrReturnReplacement = `      const ocrMessage = extracted.extractionMetrics?.extractionQuality === "heading_only"
        ? "PDF pages contain headings/page markers only; substantive text requires OCR fallback."
        : "PDF has little or no extractable text. Document marked as requires_ocr.";
      await completeKnowledgeImportLog(env22, logId, "failed", 0, ocrMessage);
      throw new RequiresOcrError(ocrMessage);`;
  if (!base.includes('extracted.extractionMetrics?.extractionQuality === "heading_only"')) {
    if (!base.includes(indexOcrReturnTarget)) {
      throw new Error("Unable to locate requires_ocr message block in base worker");
    }
    base = base.replace(indexOcrReturnTarget, indexOcrReturnReplacement);
  }
}

const uploadMetadataMarker = "metadata_json";
if (!base.includes(uploadMetadataMarker)) {
  const uploadMetaTarget = `  const uploadMetadata = buildUploadMetadata(file2.name, {
    company: String(form.get("company") ?? "").trim(),
    project: String(form.get("project") ?? "").trim(),
    category: String(form.get("category") ?? "").trim(),
    source: String(form.get("source") ?? "").trim(),
    documentDate: String(form.get("document_date") ?? "").trim(),
    department: String(form.get("department") ?? "").trim(),
    property: String(form.get("property") ?? "").trim(),
    person: String(form.get("person") ?? "").trim(),
    customer: String(form.get("customer") ?? "").trim(),
    supplier: String(form.get("supplier") ?? "").trim(),
    topic: String(form.get("topic") ?? "").trim(),
    version: String(form.get("version") ?? "").trim(),
    effectiveDate: String(form.get("effective_date") ?? "").trim(),
    expiryDate: String(form.get("expiry_date") ?? "").trim(),
    supersedesDocumentId: String(form.get("supersedes_document_id") ?? "").trim(),
    isCurrent: String(form.get("is_current") ?? "").trim()
  });`;
  const uploadMetaReplacement = `  const uploadMetadata = buildUploadMetadata(file2.name, {
    company: String(form.get("company") ?? "").trim(),
    project: String(form.get("project") ?? "").trim(),
    category: String(form.get("category") ?? "").trim(),
    source: String(form.get("source") ?? "").trim(),
    documentDate: String(form.get("document_date") ?? "").trim(),
    department: String(form.get("department") ?? "").trim(),
    property: String(form.get("property") ?? "").trim(),
    person: String(form.get("person") ?? "").trim(),
    customer: String(form.get("customer") ?? "").trim(),
    supplier: String(form.get("supplier") ?? "").trim(),
    topic: String(form.get("topic") ?? "").trim(),
    version: String(form.get("version") ?? "").trim(),
    effectiveDate: String(form.get("effective_date") ?? "").trim(),
    expiryDate: String(form.get("expiry_date") ?? "").trim(),
    supersedesDocumentId: String(form.get("supersedes_document_id") ?? "").trim(),
    isCurrent: String(form.get("is_current") ?? "").trim()
  });
  const metadataJsonRaw = String(form.get("metadata_json") ?? "").trim();
  if (metadataJsonRaw) {
    try {
      const extra = JSON.parse(metadataJsonRaw);
      if (extra && typeof extra === "object") Object.assign(uploadMetadata, extra);
    } catch {
      // ignore malformed connector metadata
    }
  }`;
  if (!base.includes(uploadMetaTarget)) {
    throw new Error("Unable to locate uploadKnowledgeDocument metadata block in base worker");
  }
  base = base.replace(uploadMetaTarget, uploadMetaReplacement);
}

const indexRouteNoWaitUntilMarker = "bridge_drives_index_continuation";
if (!base.includes(indexRouteNoWaitUntilMarker)) {
  const indexRouteWaitTarget = `      if (result?.partial) {
        const continueUrl = new URL(request.url);
        ctx.waitUntil(
          fetch(continueUrl.toString(), {
            method: "POST",
            headers: { Authorization: request.headers.get("Authorization") ?? "" }
          })
        );
      }`;
  const indexRouteWaitReplacement = `      /* bridge_drives_index_continuation: INFRA knowledge bridge loops partial batches */`;
  if (base.includes(indexRouteWaitTarget)) {
    base = base.replace(indexRouteWaitTarget, indexRouteWaitReplacement);
  }
}

const indexCatchReturnMarker = "requiresOcr: true";
if (!base.includes("return { ok: false, requiresOcr: true")) {
  const indexCatchTarget = `    } catch (error53) {
      const message = error53 instanceof Error ? error53.message : String(error53);
      return json2({ error: message }, 400);
    }
  }`;
  const indexCatchReplacement = `    } catch (error53) {
      const message = error53 instanceof Error ? error53.message : String(error53);
      if (error53?.name === "RequiresOcrError") {
        return json2({ ok: false, requiresOcr: true, documentStatus: "requires_ocr", error: message }, 200);
      }
      return json2({ error: message }, 400);
    }
  }`;
  const indexRouteBlock = `  if (indexMatch && request.method === "POST") {
    const documentId = Number(indexMatch[1]);
    try {
      const result = await indexKnowledgeDocument(env22, documentId);
`;
  if (base.includes(indexRouteBlock) && base.includes(indexCatchTarget)) {
    base = base.replace(indexCatchTarget, indexCatchReplacement);
  }
}

const inlinedXero = xeroBundle
  .replace(/\bexport\s+\{\s*registerXeroReadTools\s+as\s+__registerXeroReadTools\s*,?\s*registerXeroWriteTools\s+as\s+__registerXeroWriteTools\s*\};?\s*/g, "")
  .replace(/\bexport\s+\{\s*registerXeroReadTools\s+as\s+__registerXeroReadTools\s*\};?\s*/g, "")
  .replace(/\bexport\s+\{\s*registerXeroWriteTools\s+as\s+__registerXeroWriteTools\s*\};?\s*/g, "")
  .replace(/\bfunction registerXeroReadTools\b/g, "function __registerXeroReadTools")
  .replace(/\bfunction registerXeroWriteTools\b/g, "function __registerXeroWriteTools");

const patched = `${base}
${XERO_INJECT_BEGIN}
${inlinedXero}
function registerXeroReadTools(server, env22, external_exports) {
  return __registerXeroReadTools(server, env22, external_exports);
}
__name(registerXeroReadTools, "registerXeroReadTools");
function registerXeroWriteTools(server, env22, external_exports) {
  return __registerXeroWriteTools(server, env22, external_exports);
}
__name(registerXeroWriteTools, "registerXeroWriteTools");
${XERO_INJECT_END}
export { index_default as default };
`;

const validation = assertNoDuplicateXeroSymbols(patched);
if (!validation.ok) {
  console.error(`Build validation failed: ${validation.reason}`);
  process.exit(1);
}

fs.writeFileSync(outPath, patched);
console.log(`Built ${outPath} (${patched.length} bytes)`);
