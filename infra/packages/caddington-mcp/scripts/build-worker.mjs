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
import { applyGoogleDriveContinuationPatches } from "./google-drive-continuation-patch.mjs";

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
  const metadataMatch = url2.pathname.match(/^\\/admin\\/knowledge\\/(\\d+)\\/metadata$/);
  if (metadataMatch && request.method === "PATCH") {
    const documentId = Number(metadataMatch[1]);
    try {
      const body = await request.json().catch(() => ({}));
      const patch = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
      await mergeDocumentMetadata(env22, documentId, patch);
      return json2({ ok: true, documentId });
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
  } else if (substantiveCharacterCount < 80) {
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
  const indexOcrReturnReplacement = `      const staleChunks = await env22.CADDINGTON_BUSINESS_DATA.prepare(
        "SELECT vector_id FROM knowledge_chunks WHERE document_id = ?"
      ).bind(documentId).all();
      const staleVectorIds = (staleChunks.results ?? []).map((row) => row.vector_id).filter(Boolean);
      await env22.CADDINGTON_BUSINESS_DATA.prepare(
        "DELETE FROM knowledge_chunks WHERE document_id = ?"
      ).bind(documentId).run();
      await deleteDocumentFtsRows(env22, documentId);
      if (staleVectorIds.length > 0 && env22.CADDINGTON_KNOWLEDGE_INDEX?.deleteByIds) {
        await env22.CADDINGTON_KNOWLEDGE_INDEX.deleteByIds(staleVectorIds);
      }
      clearSearchCache();
      const ocrMessage = extracted.extractionMetrics?.extractionQuality === "heading_only"
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

const googleDriveScopeMarker = "google_drive_scope_entire_drive";
if (!base.includes(googleDriveScopeMarker)) {
  const loadConfigTarget = `async function loadGoogleDriveConnectorConfig(env22) {
  const parsed = await loadConnectorConfigJson2(env22);
  const knowledgeFolderId = env22.GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID?.trim() || (typeof parsed.knowledgeFolderId === "string" && parsed.knowledgeFolderId.trim() ? parsed.knowledgeFolderId.trim() : null);
  return {
    syncMode: "documents_only",
    writeOperationsEnabled: false,
    googlePhotosConnected: false,
    knowledgeFolderName: typeof parsed.knowledgeFolderName === "string" && parsed.knowledgeFolderName.trim() ? parsed.knowledgeFolderName.trim() : GOOGLE_DRIVE_KNOWLEDGE_FOLDER_NAME,
    knowledgeFolderId,
    allowList: parseGoogleDriveAllowListConfig(parsed.allowList ?? parsed),
    schedule: await loadGoogleDriveScheduleConfig(env22)
  };
}`;
  const loadConfigReplacement = `async function loadGoogleDriveConnectorConfig(env22) {
  const parsed = await loadConnectorConfigJson2(env22);
  const scopeMode = parsed.scopeMode === "ENTIRE_DRIVE" ? "ENTIRE_DRIVE" : "SELECTED_FOLDERS";
  const imageIngestionPolicy = parsed.imageIngestionPolicy === "ALLOWED" ? "ALLOWED" : "EXCLUDED";
  const knowledgeFolderId = env22.GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID?.trim() || (typeof parsed.knowledgeFolderId === "string" && parsed.knowledgeFolderId.trim() ? parsed.knowledgeFolderId.trim() : null);
  const scanRootId = scopeMode === "ENTIRE_DRIVE" ? "root" : knowledgeFolderId;
  let allowList = parseGoogleDriveAllowListConfig(parsed.allowList ?? parsed);
  if (imageIngestionPolicy === "ALLOWED") {
    allowList = {
      ...allowList,
      excludedMimeTypePrefixes: allowList.excludedMimeTypePrefixes.filter((p) => p !== "image/"),
      excludeImageExtensions: false
    };
  } else {
    allowList = { ...allowList, excludeImageExtensions: true };
  }
  return {
    syncMode: "documents_only",
    writeOperationsEnabled: false,
    googlePhotosConnected: false,
    scopeMode,
    imageIngestionPolicy,
    scanRootId,
    knowledgeFolderName: typeof parsed.knowledgeFolderName === "string" && parsed.knowledgeFolderName.trim() ? parsed.knowledgeFolderName.trim() : GOOGLE_DRIVE_KNOWLEDGE_FOLDER_NAME,
    knowledgeFolderId,
    allowList,
    schedule: await loadGoogleDriveScheduleConfig(env22)
  };
}`;
  if (!base.includes(loadConfigTarget)) {
    throw new Error("Unable to locate loadGoogleDriveConnectorConfig in base worker");
  }
  base = base.replace(loadConfigTarget, loadConfigReplacement);

  const classifyExtTarget = `  if (GOOGLE_DRIVE_EXCLUDED_EXTENSIONS.includes(extension)) {
    return { allowed: false, reason: "excluded_extension" };
  }`;
  const classifyExtReplacement = `  const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".svg", ".ico", ".raw", ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf"];
  const skipExtension = config3.excludeImageExtensions === false
    ? GOOGLE_DRIVE_EXCLUDED_EXTENSIONS.filter((ext) => !imageExtensions.includes(ext)).includes(extension)
    : GOOGLE_DRIVE_EXCLUDED_EXTENSIONS.includes(extension);
  if (skipExtension) {
    return { allowed: false, reason: "excluded_extension" };
  }`;
  if (!base.includes("excludeImageExtensions")) {
    if (!base.includes(classifyExtTarget)) {
      throw new Error("Unable to locate classifyGoogleDriveFile extension check in base worker");
    }
    base = base.replace(classifyExtTarget, classifyExtReplacement);
  }

  const listAllTarget = `  async listAllFilesInFolder(rootFolderId, pageSize = 100) {
    const files = [];
    const folderQueue = [rootFolderId];
    const visitedFolders = /* @__PURE__ */ new Set();
    while (folderQueue.length > 0) {
      const folderId = folderQueue.shift();
      if (!folderId || visitedFolders.has(folderId)) {
        continue;
      }
      visitedFolders.add(folderId);
      let pageToken;
      do {
        const page = await this.listFolderChildrenPage(folderId, pageSize, pageToken);
        for (const item of page.files) {
          if (item.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
            folderQueue.push(item.id);
          } else {
            files.push(item);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    return files;
  }`;
  const listAllReplacement = `  async listAllFilesInFolder(rootFolderId, pageSize = 100, options = {}) {
    const myDriveOnly = options.myDriveOnly ?? rootFolderId === "root";
    const files = [];
    const seenFileIds = /* @__PURE__ */ new Set();
    const folderQueue = [rootFolderId];
    const visitedFolders = /* @__PURE__ */ new Set();
    while (folderQueue.length > 0) {
      const folderId = folderQueue.shift();
      if (!folderId || visitedFolders.has(folderId)) {
        continue;
      }
      visitedFolders.add(folderId);
      let pageToken;
      do {
        const page = await this.listFolderChildrenPage(folderId, pageSize, pageToken, myDriveOnly);
        for (const item of page.files) {
          if (item.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
            folderQueue.push(item.id);
          } else if (item.mimeType === "application/vnd.google-apps.shortcut") {
            continue;
          } else if (!seenFileIds.has(item.id)) {
            seenFileIds.add(item.id);
            files.push(item);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    return files;
  }`;
  if (!base.includes("seenFileIds")) {
    if (!base.includes(listAllTarget)) {
      throw new Error("Unable to locate listAllFilesInFolder in base worker");
    }
    base = base.replace(listAllTarget, listAllReplacement);
  }

  const listPageTarget = `  async listFolderChildrenPage(folderId, pageSize = 100, pageToken) {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({
      q: buildGoogleDriveFolderChildrenQuery(folderId),
      pageSize: String(pageSize),
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });`;
  const listPageReplacement = `  async listFolderChildrenPage(folderId, pageSize = 100, pageToken, myDriveOnly = false) {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({
      q: buildGoogleDriveFolderChildrenQuery(folderId),
      pageSize: String(pageSize),
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents,shortcutDetails)",
      supportsAllDrives: myDriveOnly ? "false" : "true",
      includeItemsFromAllDrives: myDriveOnly ? "false" : "true"
    });`;
  if (!base.includes("myDriveOnly")) {
    if (!base.includes(listPageTarget)) {
      throw new Error("Unable to locate listFolderChildrenPage in base worker");
    }
    base = base.replace(listPageTarget, listPageReplacement);
  }

  const listMyDriveFlatMarker = "listAllMyDriveFilesFlat";
  if (!base.includes(listMyDriveFlatMarker)) {
    const listMyDriveInsertTarget = `  classifyFiles(files, config3) {
    return files.map((file2) => ({
      ...file2,
      filterDecision: classifyGoogleDriveFile(file2, config3)
    }));
  }`;
    const listMyDriveInsertReplacement = `  async listAllMyDriveFilesFlat(options = {}) {
    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? 15;
    const startPageToken = options.pageToken ?? void 0;
    const files = [];
    const seenFileIds = /* @__PURE__ */ new Set();
    let pageToken = startPageToken;
    let pagesFetched = 0;
    do {
      const token = await this.getAccessToken();
      const params = new URLSearchParams({
        corpora: "user",
        q: "trashed = false",
        pageSize: String(pageSize),
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents,shortcutDetails)",
        supportsAllDrives: "false",
        includeItemsFromAllDrives: "false"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await fetch(\`\${DRIVE_FILES_URL}?\${params.toString()}\`, {
        headers: { Authorization: \`Bearer \${token}\` }
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(\`Google Drive flat list failed (\${response.status}): \${body}\`);
      }
      const payload = await response.json();
      for (const item of payload.files ?? []) {
        if (item.mimeType === GOOGLE_DRIVE_FOLDER_MIME) continue;
        if (item.mimeType === "application/vnd.google-apps.shortcut") continue;
        if (!seenFileIds.has(item.id)) {
          seenFileIds.add(item.id);
          files.push(item);
        }
      }
      pageToken = payload.nextPageToken;
      pagesFetched++;
    } while (pageToken && pagesFetched < maxPages);
    return { files, nextPageToken: pageToken ?? null, complete: !pageToken };
  }
  classifyFiles(files, config3) {
    return files.map((file2) => ({
      ...file2,
      filterDecision: classifyGoogleDriveFile(file2, config3)
    }));
  }`;
    if (!base.includes(listMyDriveInsertTarget)) {
      throw new Error("Unable to locate classifyFiles for My Drive flat list insert");
    }
    base = base.replace(listMyDriveInsertTarget, listMyDriveInsertReplacement);
  }

  const scanListTarget = `    const listed = await client.listAllFilesInFolder(
      connectorConfig.knowledgeFolderId
    );`;
  const scanListReplacement = `    let listedFiles = [];
    let scanContinuation = null;
    if (connectorConfig.scopeMode === "ENTIRE_DRIVE") {
      const parsedScan = await loadConnectorConfigJson2(env22);
      const scanState = parsedScan.scanState && typeof parsedScan.scanState === "object" ? parsedScan.scanState : {};
      const flat = await client.listAllMyDriveFilesFlat({
        pageToken: typeof scanState.pageToken === "string" ? scanState.pageToken : void 0,
        maxPages: 15
      });
      listedFiles = flat.files;
      scanContinuation = flat.complete ? null : flat.nextPageToken;
      const nextConfig = {
        ...parsedScan,
        scanState: {
          pageToken: scanContinuation,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
      await env22.CADDINGTON_BUSINESS_DATA.prepare(
        \`INSERT INTO connector_config (connector_code, config_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(connector_code) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at\`
      ).bind(CONNECTOR_CODE2, JSON.stringify(nextConfig)).run();
    } else {
      listedFiles = await client.listAllFilesInFolder(
        connectorConfig.knowledgeFolderId
      );
    }
    const listed = listedFiles;`;
  if (base.includes(scanListTarget)) {
    base = base.replace(scanListTarget, scanListReplacement);
  } else if (base.includes(`const listed = connectorConfig.scopeMode === "ENTIRE_DRIVE"`)) {
    base = base.replace(
      /const listed = connectorConfig\.scopeMode === "ENTIRE_DRIVE"[\s\S]*?\{ myDriveOnly: false \}\s*\);/,
      scanListReplacement.trim(),
    );
  }

  const previewSubfolderTarget = `  const subfolders = rootPage.files.filter(
    (file2) => file2.mimeType === "application/vnd.google-apps.folder"
  );
  const subfolderInventories = [];
  for (const folder of subfolders) {
    const page = await client.listFolderChildrenPage(folder.id);
    const children = client.classifyFiles(page.files, connectorConfig.allowList).map(
      (file2) => ({
        id: file2.id,
        name: file2.name,
        mimeType: file2.mimeType,
        allowed: file2.filterDecision.allowed,
        reason: file2.filterDecision.allowed ? file2.filterDecision.reason : file2.filterDecision.reason
      })
    );
    subfolderInventories.push({
      folderId: folder.id,
      folderName: folder.name,
      childCount: page.files.length,
      children
    });
  }
  const recursive = client.classifyFiles(
    await client.listAllFilesInFolder(connectorConfig.knowledgeFolderId),
    connectorConfig.allowList
  );`;
  const previewSubfolderReplacement = `  const subfolders = rootPage.files.filter(
    (file2) => file2.mimeType === "application/vnd.google-apps.folder"
  );
  const subfolderInventories = [];
  if (connectorConfig.scopeMode !== "ENTIRE_DRIVE") {
    for (const folder of subfolders) {
      const page = await client.listFolderChildrenPage(folder.id);
      const children = client.classifyFiles(page.files, connectorConfig.allowList).map(
        (file2) => ({
          id: file2.id,
          name: file2.name,
          mimeType: file2.mimeType,
          allowed: file2.filterDecision.allowed,
          reason: file2.filterDecision.allowed ? file2.filterDecision.reason : file2.filterDecision.reason
        })
      );
      subfolderInventories.push({
        folderId: folder.id,
        folderName: folder.name,
        childCount: page.files.length,
        children
      });
    }
  }
  const recursive = client.classifyFiles(
    connectorConfig.scopeMode === "ENTIRE_DRIVE"
      ? (await client.listAllMyDriveFilesFlat({ maxPages: 15 })).files
      : await client.listAllFilesInFolder(connectorConfig.knowledgeFolderId),
    connectorConfig.allowList
  );`;
  if (base.includes(previewSubfolderTarget)) {
    base = base.replace(previewSubfolderTarget, previewSubfolderReplacement);
  }

  base = base.replaceAll(
    "knowledgeFolderConfigured: connectorConfig.knowledgeFolderId !== null",
    "knowledgeFolderConfigured: connectorConfig.scanRootId !== null",
  );
  base = base.replaceAll(
    "if (!connectorConfig.knowledgeFolderId) {\n    throw new Error(\"Google Drive knowledge folder is not configured.\");",
    "if (!connectorConfig.scanRootId) {\n    throw new Error(\"Google Drive scan root is not configured. Set scopeMode ENTIRE_DRIVE or connector_config.knowledgeFolderId.\");",
  );
  base = base.replaceAll(
    `if (!connectorConfig.knowledgeFolderId) {
    throw new Error(
      \`Google Drive knowledge folder is not configured. Set GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID or connector_config.knowledgeFolderId for "\${connectorConfig.knowledgeFolderName}".\`
    );
  }`,
    `if (!connectorConfig.scanRootId) {
    throw new Error(
      \`Google Drive scan root is not configured. Set scopeMode ENTIRE_DRIVE or GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID / connector_config.knowledgeFolderId for "\${connectorConfig.knowledgeFolderName}".\`
    );
  }`,
  );
  base = base.replaceAll(
    "await client.listAllFilesInFolder(\n      connectorConfig.knowledgeFolderId\n    )",
    "await client.listAllFilesInFolder(\n      connectorConfig.scanRootId,\n      100,\n      { myDriveOnly: connectorConfig.scopeMode === \"ENTIRE_DRIVE\" }\n    )",
  );
  base = base.replaceAll(
    "await client.listAllFilesInFolder(connectorConfig.knowledgeFolderId)",
    "await client.listAllFilesInFolder(connectorConfig.scanRootId, 100, { myDriveOnly: connectorConfig.scopeMode === \"ENTIRE_DRIVE\" })",
  );
  base = base.replaceAll(
    "connectorConfig.knowledgeFolderId\n  );",
    "connectorConfig.scanRootId\n  );",
  );

  const statusNotesTarget = `notes: "Documents-only sync restricted to the Caddington Knowledge folder and its subfolders. Daily metadata scan at 12:00 Europe/London with queue fan-out for per-file import/index. Personal photos, images, videos and audio are excluded via MIME allow-list before download. Google Photos is not connected. Drive OAuth uses full drive scope for future folder writes; sync remains read-only. Image ingestion is manual-upload only."`;
  const statusNotesReplacement = `notes: "Documents-only sync with per-company scope (SELECTED_FOLDERS or ENTIRE_DRIVE My Drive). Daily metadata scan at 12:00 Europe/London with queue fan-out. Image ingestion policy is configurable per company (Caddington: EXCLUDED). Trash and Google Photos are never ingested. Shortcuts are not traversed. google_drive_scope_entire_drive"`;
  if (base.includes(statusNotesTarget)) {
    base = base.replace(statusNotesTarget, statusNotesReplacement);
  }

  const statusFieldsTarget = `    knowledgeFolderName: connectorConfig.knowledgeFolderName,
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    allowList: connectorConfig.allowList,`;
  const statusFieldsReplacement = `    scopeMode: connectorConfig.scopeMode,
    imageIngestionPolicy: connectorConfig.imageIngestionPolicy,
    scanRootId: connectorConfig.scanRootId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName,
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    allowList: connectorConfig.allowList,`;
  if (base.includes(statusFieldsTarget) && !base.includes("scopeMode: connectorConfig.scopeMode")) {
    base = base.replace(statusFieldsTarget, statusFieldsReplacement);
  }

  const scanMetaTarget = `      knowledgeFolderId: connectorConfig.knowledgeFolderId,
      knowledgeFolderName: connectorConfig.knowledgeFolderName,
      phase: "metadata_scan"`;
  const scanMetaReplacement = `      scopeMode: connectorConfig.scopeMode,
      scanRootId: connectorConfig.scanRootId,
      knowledgeFolderId: connectorConfig.knowledgeFolderId,
      knowledgeFolderName: connectorConfig.knowledgeFolderName,
      phase: "metadata_scan"`;
  if (base.includes(scanMetaTarget)) {
    base = base.replace(scanMetaTarget, scanMetaReplacement);
  }

  const docMetaTarget = `    syncMode: "documents_only",
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName
  };`;
  const docMetaReplacement = `    syncMode: "documents_only",
    scopeMode: connectorConfig.scopeMode,
    scanRootId: connectorConfig.scanRootId,
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName
  };`;
  if (base.includes(docMetaTarget)) {
    base = base.replace(docMetaTarget, docMetaReplacement);
  }

  const previewReturnTarget = `  return {
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName,
    rootChildren,`;
  const previewReturnReplacement = `  return {
    scopeMode: connectorConfig.scopeMode,
    scanRootId: connectorConfig.scanRootId,
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName,
    rootChildren,`;
  if (base.includes(previewReturnTarget) && !base.includes("scopeMode: connectorConfig.scopeMode")) {
    base = base.replace(previewReturnTarget, previewReturnReplacement);
  }
}

const ocrExtractedIndexMarker = "ocr_index_extracted_v1";
if (!base.includes(ocrExtractedIndexMarker)) {
  const extractCallTarget = `    const extracted = await extractDocument(
      env22,
      bytes,
      doc.mime_type ?? object2.httpMetadata?.contentType ?? "text/plain",
      doc.r2_key
    );`;
  const extractCallReplacement = `    /* ocr_index_extracted_v1 */
    let extracted;
    const ocrReuseMeta = parseDocumentMetadataJson(doc.metadata);
    if (ocrReuseMeta.ocrStatus === "ocr_completed" && ocrReuseMeta.ocrTextR2Key) {
      const ocrObject = await env22.CADDINGTON_KNOWLEDGE.get(ocrReuseMeta.ocrTextR2Key);
      if (ocrObject) {
        const ocrText = await ocrObject.text();
        extracted = {
          format: "txt",
          segments: plainTextToSegments(ocrText, "txt"),
          requiresOcr: false,
          rawTextLength: ocrText.length,
          extractionMetrics: {
            extractionMethod: "azure_document_intelligence_prebuilt_read",
            extractionQuality: "good",
            fallbackRequired: true,
            fallbackOutcome: "azure_document_intelligence",
            requiresOcr: false
          }
        };
      }
    }
    if (!extracted) {
      extracted = await extractDocument(
        env22,
        bytes,
        doc.mime_type ?? object2.httpMetadata?.contentType ?? "text/plain",
        doc.r2_key
      );
    }`;
  if (!base.includes(extractCallTarget)) {
    throw new Error("Unable to locate extractDocument call for OCR reuse patch");
  }
  base = base.replace(extractCallTarget, extractCallReplacement);

  const ocrAdminTarget = `  return json2({ error: "Not Found" }, 404);
}
__name(handleAdminRequest, "handleAdminRequest");`;
  const ocrAdminReplacement = `  const knowledgeGetMatch = url2.pathname.match(/^\\/admin\\/knowledge\\/(\\d+)$/);
  if (knowledgeGetMatch && request.method === "GET") {
    const documentId = Number(knowledgeGetMatch[1]);
    const doc = await env22.CADDINGTON_BUSINESS_DATA.prepare(
      "SELECT id, external_id, title, status, mime_type, byte_size, metadata FROM knowledge_documents WHERE id = ?"
    ).bind(documentId).first();
    if (!doc) return json2({ error: "Document not found" }, 404);
    let metadata = {};
    try { metadata = doc.metadata ? JSON.parse(doc.metadata) : {}; } catch { metadata = {}; }
    return json2({
      ok: true,
      documentId: doc.id,
      title: doc.title ?? null,
      status: doc.status ?? null,
      mimeType: doc.mime_type ?? null,
      externalId: doc.external_id ?? null,
      byteSize: doc.byte_size ?? null,
      metadata
    });
  }
  const knowledgeContentMatch = url2.pathname.match(/^\\/admin\\/knowledge\\/(\\d+)\\/content$/);
  if (knowledgeContentMatch && request.method === "GET") {
    const documentId = Number(knowledgeContentMatch[1]);
    const doc = await env22.CADDINGTON_BUSINESS_DATA.prepare(
      "SELECT r2_key, mime_type FROM knowledge_documents WHERE id = ?"
    ).bind(documentId).first();
    if (!doc) return json2({ error: "Document not found" }, 404);
    const object2 = await env22.CADDINGTON_KNOWLEDGE.get(doc.r2_key);
    if (!object2) return json2({ error: "Storage object missing" }, 404);
    return new Response(object2.body, {
      headers: { "Content-Type": doc.mime_type || "application/octet-stream" }
    });
  }
  const indexExtractedMatch = url2.pathname.match(/^\\/admin\\/knowledge\\/(\\d+)\\/index-extracted$/);
  if (indexExtractedMatch && request.method === "POST") {
    const documentId = Number(indexExtractedMatch[1]);
    try {
      const body = await request.json().catch(() => ({}));
      const text = String(body.text ?? "");
      if (!text.trim()) return json2({ error: "Extracted text is required" }, 400);
      const doc = await env22.CADDINGTON_BUSINESS_DATA.prepare(
        "SELECT id, external_id FROM knowledge_documents WHERE id = ?"
      ).bind(documentId).first();
      if (!doc) return json2({ error: "Document not found" }, 404);
      const fingerprint = String(body.fingerprint ?? "ocr").replace(/[^a-zA-Z0-9._-]/g, "_");
      const ocrKey = \`ocr/\${doc.external_id}/\${fingerprint}.txt\`;
      await env22.CADDINGTON_KNOWLEDGE.put(ocrKey, text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" }
      });
      const metaPatch = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
      await mergeDocumentMetadata(env22, documentId, { ...metaPatch, ocrTextR2Key: ocrKey, ocrStatus: metaPatch.ocrStatus ?? "ocr_completed" });
      const result = await indexKnowledgeDocument(env22, documentId);
      return json2({ ok: true, documentId, documentStatus: result?.partial ? "pending" : "indexed", ...result });
    } catch (error53) {
      const message = error53 instanceof Error ? error53.message : String(error53);
      return json2({ error: message }, 400);
    }
  }
  return json2({ error: "Not Found" }, 404);
}
__name(handleAdminRequest, "handleAdminRequest");`;
  if (!base.includes(ocrAdminTarget)) {
    throw new Error("Unable to locate handleAdminRequest footer for OCR admin routes");
  }
  base = base.replace(ocrAdminTarget, ocrAdminReplacement);
}

base = applyGoogleDriveContinuationPatches(base);

const knowledgeActivityMarker = "/admin/knowledge/activity";
if (!base.includes(knowledgeActivityMarker)) {
  const activityTarget = `  return json2({ error: "Not Found" }, 404);
}
__name(handleAdminRequest, "handleAdminRequest");`;
  const activityReplacement = `  if (url2.pathname === "/admin/knowledge/activity" && request.method === "GET") {
    const since = url2.searchParams.get("since");
    const driveCount = await env22.CADDINGTON_BUSINESS_DATA.prepare(
      "SELECT COUNT(DISTINCT knowledge_document_id) AS n FROM google_drive_files WHERE knowledge_document_id IS NOT NULL"
    ).first();
    let documents = [];
    let googleDriveNewCount = 0;
    let googleDriveUpdatedCount = 0;
    if (since) {
      const sinceSqlite = String(since).replace("T", " ").replace(/\\.\\d+Z$/, "").replace("Z", "");
      const newRow = await env22.CADDINGTON_BUSINESS_DATA.prepare(
        \`SELECT COUNT(*) AS n FROM knowledge_documents
         WHERE COALESCE(status, '') != 'archived'
           AND json_extract(metadata, '\$.source') = 'google_drive'
           AND (created_at >= ? OR created_at >= ?)\`
      ).bind(since, sinceSqlite).first();
      googleDriveNewCount = Number(newRow?.n ?? 0);
      const updatedRow = await env22.CADDINGTON_BUSINESS_DATA.prepare(
        \`SELECT COUNT(*) AS n FROM knowledge_documents
         WHERE COALESCE(status, '') != 'archived'
           AND json_extract(metadata, '\$.source') = 'google_drive'
           AND created_at < ?
           AND json_extract(metadata, '\$.driveModifiedTime') >= ?\`
      ).bind(sinceSqlite, since).first();
      googleDriveUpdatedCount = Number(updatedRow?.n ?? 0);
      const rows = await env22.CADDINGTON_BUSINESS_DATA.prepare(
        \`SELECT id, title, status, created_at, updated_at, indexed_at, metadata
         FROM knowledge_documents
         WHERE COALESCE(status, '') != 'archived'
           AND json_extract(metadata, '$.source') = 'google_drive'
           AND (
             created_at >= ? OR created_at >= ?
             OR json_extract(metadata, '$.driveModifiedTime') >= ?
           )
         ORDER BY created_at DESC
         LIMIT 200\`
      ).bind(since, sinceSqlite, since).all();
      documents = (rows.results ?? []).map((row) => {
        let metadata = {};
        try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { metadata = {}; }
        return {
          title: row.title ?? "Untitled document",
          source: metadata.source ?? "google_drive",
          category: metadata.category ?? null,
          createdAt: row.created_at ?? null,
          updatedAt: row.updated_at ?? null,
          driveModifiedTime: metadata.driveModifiedTime ?? null,
          status: row.status ?? null
        };
      });
    }
    return json2({
      ok: true,
      readOnly: true,
      triggeredProviderScan: false,
      googleDriveUniqueCount: Number(driveCount?.n ?? 0),
      googleDriveNewCount,
      googleDriveUpdatedCount,
      documents
    });
  }
  return json2({ error: "Not Found" }, 404);
}
__name(handleAdminRequest, "handleAdminRequest");`;
  if (!base.includes(activityTarget)) {
    throw new Error("Unable to locate handleAdminRequest footer for knowledge activity route");
  }
  base = base.replace(activityTarget, activityReplacement);
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
