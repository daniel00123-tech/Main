/** Persist genuine Google Drive webViewLink / webContentLink on knowledge docs. */

const MARKER = "google_drive_provider_url_fields";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,md5Checksum,size,parents,webViewLink,webContentLink";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

export function applyGoogleDriveUrlPatches(base) {
  if (base.includes(MARKER) && base.includes("webViewLink,webContentLink")) {
    return base;
  }

  let next = base;

  const getFieldsTarget = `fields: "id,name,mimeType,modifiedTime,md5Checksum,size,parents",`;
  const getFieldsReplacement = `fields: "${FILE_FIELDS}",`;
  if (next.includes(getFieldsTarget)) {
    next = next.replace(getFieldsTarget, getFieldsReplacement);
  }

  const listFieldsTarget =
    `fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents)",`;
  const listFieldsReplacement = `fields: "${LIST_FIELDS}",`;
  if (next.includes(listFieldsTarget)) {
    next = next.replace(listFieldsTarget, listFieldsReplacement);
  }

  const persistTarget = `    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName
  };`;
  const persistReplacement = `    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName,
    webViewLink: file2.webViewLink ?? null,
    webContentLink: file2.webContentLink ?? null
  };`;
  if (!next.includes("webViewLink: file2.webViewLink") && next.includes(persistTarget)) {
    next = next.replace(persistTarget, persistReplacement);
  }

  const chunkTarget = `    source: docMeta.source ?? "",
    documentDate: docMeta.documentDate ?? "",`;
  const chunkReplacement = `    source: docMeta.source ?? "",
    webViewLink: typeof docMeta.webViewLink === "string" ? docMeta.webViewLink : "",
    webContentLink: typeof docMeta.webContentLink === "string" ? docMeta.webContentLink : "",
    sourceUrl: typeof docMeta.sourceUrl === "string" ? docMeta.sourceUrl : typeof docMeta.webUrl === "string" ? docMeta.webUrl : "",
    documentDate: docMeta.documentDate ?? "",`;
  if (!next.includes("webViewLink: typeof docMeta.webViewLink") && next.includes(chunkTarget)) {
    next = next.replace(chunkTarget, chunkReplacement);
  }

  const searchTarget = `    source: record2.source || void 0,
    provenance: provenanceFromRecord(record2),`;
  const searchReplacement = `    source: record2.source || void 0,
    url: firstHttpUrlFromDriveMeta(record2),
    webViewLink: record2.webViewLink || void 0,
    webContentLink: record2.webContentLink || void 0,
    sourceUrl: record2.sourceUrl || void 0,
    provenance: provenanceFromRecord(record2),`;
  if (!next.includes("url: firstHttpUrlFromDriveMeta(record2)") && next.includes(searchTarget)) {
    next = next.replace(searchTarget, searchReplacement);
  }

  const provenanceTarget = `    source: record2.source || void 0,
    version: record2.version,`;
  const provenanceReplacement = `    source: record2.source || void 0,
    webViewLink: record2.webViewLink || void 0,
    webContentLink: record2.webContentLink || void 0,
    sourceUrl: record2.sourceUrl || void 0,
    url: firstHttpUrlFromDriveMeta(record2) || void 0,
    version: record2.version,`;
  if (!next.includes("webViewLink: record2.webViewLink || void 0,") && next.includes(provenanceTarget)) {
    next = next.replace(provenanceTarget, provenanceReplacement);
  }

  const helperTarget = `async function getKnowledgeDocument(env22, documentRef) {`;
  const helperReplacement = `function firstHttpUrlFromDriveMeta(source) {
  const candidates = [
    source?.url,
    source?.sourceUrl,
    source?.source_url,
    source?.webUrl,
    source?.web_url,
    source?.webViewLink,
    source?.webContentLink
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\\/\\//i.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  return "";
}
__name(firstHttpUrlFromDriveMeta, "firstHttpUrlFromDriveMeta");
__name2(firstHttpUrlFromDriveMeta, "firstHttpUrlFromDriveMeta");
async function persistProviderUrlsOnDocument(env22, documentId, patch) {
  const row = await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT metadata FROM knowledge_documents WHERE id = ?"
  ).bind(documentId).first();
  let base = {};
  if (row?.metadata) {
    try { base = JSON.parse(row.metadata); } catch { base = {}; }
  }
  const nextMeta = { ...base };
  if (patch.webViewLink) nextMeta.webViewLink = patch.webViewLink;
  if (patch.webContentLink) nextMeta.webContentLink = patch.webContentLink;
  if (JSON.stringify(nextMeta) === JSON.stringify(base)) return { changed: false, metadata: nextMeta };
  await env22.CADDINGTON_BUSINESS_DATA.prepare(
    "UPDATE knowledge_documents SET metadata = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(JSON.stringify(nextMeta), documentId).run();
  return { changed: true, metadata: nextMeta };
}
__name(persistProviderUrlsOnDocument, "persistProviderUrlsOnDocument");
__name2(persistProviderUrlsOnDocument, "persistProviderUrlsOnDocument");
async function getKnowledgeDocument(env22, documentRef) {`;
  if (!next.includes("function firstHttpUrlFromDriveMeta") && next.includes(helperTarget)) {
    next = next.replace(helperTarget, helperReplacement);
  }

  const fetchReturnTarget = `  return {
    document: doc,
    chunks: normalizedChunks,
    importHistory: importHistory.results
  };`;
  const fetchReturnReplacement = `  let parsedMeta = {};
  try { parsedMeta = doc.metadata ? JSON.parse(doc.metadata) : {}; } catch { parsedMeta = {}; }
  const providerUrl = firstHttpUrlFromDriveMeta(parsedMeta);
  return {
    document: {
      ...doc,
      metadata: parsedMeta,
      url: providerUrl,
      webViewLink: parsedMeta.webViewLink ?? null,
      webContentLink: parsedMeta.webContentLink ?? null
    },
    chunks: normalizedChunks,
    importHistory: importHistory.results
  };`;
  if (!next.includes("webViewLink: parsedMeta.webViewLink") && next.includes(fetchReturnTarget)) {
    next = next.replace(fetchReturnTarget, fetchReturnReplacement);
  }

  const adminTarget = `  if (url2.pathname === "/admin/health") {
    return json2({ ok: true, service: "caddington-mcp-admin" });
  }`;
  const adminReplacement = `  if (url2.pathname === "/admin/health") {
    return json2({ ok: true, service: "caddington-mcp-admin" });
  }
  if (url2.pathname === "/admin/knowledge/backfill-provider-urls" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(50, Math.max(1, Number(body.limit ?? 20) || 20));
    const externalId = typeof body.externalId === "string" ? body.externalId.trim() : "";
    const credentials = parseGoogleDriveCredentials(env22.GOOGLE_DRIVE_CREDENTIALS);
    if (!credentials) return json2({ error: "GOOGLE_DRIVE_CREDENTIALS is not configured." }, 400);
    const client = new GoogleDriveClient(credentials);
    const rows = externalId
      ? (await env22.CADDINGTON_BUSINESS_DATA.prepare(
          \`SELECT id, external_id, title, metadata FROM knowledge_documents
           WHERE external_id = ? AND COALESCE(status, '') != 'archived' LIMIT 1\`
        ).bind(externalId).all()).results ?? []
      : (await env22.CADDINGTON_BUSINESS_DATA.prepare(
          \`SELECT id, external_id, title, metadata FROM knowledge_documents
           WHERE external_id LIKE 'gdrive-%'
             AND COALESCE(status, '') != 'archived'
             AND (json_extract(metadata, '$.webViewLink') IS NULL OR json_extract(metadata, '$.webViewLink') = '')
           ORDER BY id ASC
           LIMIT ?\`
        ).bind(limit).all()).results ?? [];
    const updated = [];
    const missing = [];
    const errors = [];
    for (const row of rows) {
      let meta3 = {};
      try { meta3 = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta3 = {}; }
      const driveFileId = String(meta3.driveFileId ?? "").trim() || String(row.external_id ?? "").replace(/^gdrive-/, "");
      if (!driveFileId) {
        missing.push({ documentId: row.id, externalId: row.external_id, reason: "no_drive_file_id" });
        continue;
      }
      try {
        const file2 = await client.getFileMetadata(driveFileId);
        const webViewLink = typeof file2?.webViewLink === "string" ? file2.webViewLink : "";
        const webContentLink = typeof file2?.webContentLink === "string" ? file2.webContentLink : "";
        if (!webViewLink && !webContentLink) {
          missing.push({
            documentId: row.id,
            externalId: row.external_id,
            driveFileId,
            reason: "provider_has_no_url",
            fields: { id: file2?.id ?? null, name: file2?.name ?? null, mimeType: file2?.mimeType ?? null, webViewLink: file2?.webViewLink ?? null, webContentLink: file2?.webContentLink ?? null }
          });
          continue;
        }
        const persisted = await persistProviderUrlsOnDocument(env22, row.id, { webViewLink, webContentLink });
        updated.push({
          documentId: row.id,
          externalId: row.external_id,
          title: row.title,
          driveFileId,
          webViewLink: webViewLink || null,
          webContentLink: webContentLink || null,
          changed: persisted.changed
        });
      } catch (error53) {
        errors.push({ documentId: row.id, externalId: row.external_id, error: error53 instanceof Error ? error53.message : String(error53) });
      }
    }
    return json2({ ok: true, marker: "${MARKER}", scanned: rows.length, updated: updated.length, missing: missing.length, errors: errors.length, results: { updated, missing, errors } });
  }`;
  if (!next.includes("/admin/knowledge/backfill-provider-urls") && next.includes(adminTarget)) {
    next = next.replace(adminTarget, adminReplacement);
  }

  return next;
}
