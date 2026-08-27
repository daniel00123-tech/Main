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
