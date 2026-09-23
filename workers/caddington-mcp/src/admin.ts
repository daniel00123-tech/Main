import type { Env } from "./db";
import {
  getGoogleDriveConnectorStatus,
  previewGoogleDriveKnowledgeFolder,
  syncGoogleDriveDocuments,
} from "./google-drive-sync";
import { log } from "./logger";
import { buildUploadMetadata } from "./knowledge-metadata";
import { indexKnowledgeDocument } from "./knowledge";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

export function checkAdminAuth(request: Request, env: Env): boolean {
  const expected = env.CADDINGTON_ADMIN_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === expected;
}

export async function handleAdminRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (!checkAdminAuth(request, env)) {
    log("warn", "admin_auth_failed", { path: url.pathname });
    return unauthorized();
  }

  if (url.pathname === "/admin/health") {
    return json({ ok: true, service: "caddington-mcp-admin" });
  }

  if (url.pathname === "/admin/import/csv" && request.method === "POST") {
    return await importCsv(request, env);
  }

  if (url.pathname === "/admin/knowledge/upload" && request.method === "POST") {
    return await uploadKnowledgeDocument(request, env);
  }

  if (url.pathname === "/admin/connectors/google_drive" && request.method === "GET") {
    return json(await getGoogleDriveConnectorStatus(env));
  }

  if (
    url.pathname === "/admin/connectors/google_drive/preview" &&
    request.method === "GET"
  ) {
    try {
      return json(await previewGoogleDriveKnowledgeFolder(env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  }

  if (
    url.pathname === "/admin/connectors/google_drive/sync" &&
    request.method === "POST"
  ) {
    const body = await request.json<{
      dryRun?: boolean;
      maxFiles?: number;
      autoIndex?: boolean;
    }>().catch(() => ({} as { dryRun?: boolean; maxFiles?: number; autoIndex?: boolean }));

    try {
      const summary = await syncGoogleDriveDocuments(env, {
        dryRun: body.dryRun ?? false,
        maxFiles: body.maxFiles,
        autoIndex: body.autoIndex,
      });
      return json({ ok: true, ...summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  }

  const indexMatch = url.pathname.match(
    /^\/admin\/knowledge\/(\d+)\/index$/
  );
  if (indexMatch && request.method === "POST") {
    const documentId = Number(indexMatch[1]);
    try {
      const result = await indexKnowledgeDocument(env, documentId);
      return json({ ok: true, documentId, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  }

  return json({ error: "Not Found" }, 404);
}

async function importCsv(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    csv?: string;
    entityType?: string;
    sourceSystem?: string;
  }>();

  if (!body.csv?.trim()) {
    return json({ error: "csv field is required." }, 400);
  }
  const entityType = body.entityType?.trim() || "generic";
  const sourceSystem = body.sourceSystem?.trim() || "csv_import";

  const importResult = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO import_log (source_system, import_type, status, metadata)
     VALUES (?, 'csv', 'started', ?)`
  )
    .bind(
      sourceSystem,
      JSON.stringify({ entityType, via: "admin/import/csv" })
    )
    .run();
  const batchId = importResult.meta.last_row_id;

  const lines = body.csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return json({ error: "CSV must include a header row and at least one data row." }, 400);
  }

  const headers = parseCsvLine(lines[0]);
  let processed = 0;
  let failed = 0;

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });

    const externalId =
      row.external_id || row.id || `${entityType}-${i}`;
    const recordDate = row.record_date || row.date || null;

    try {
      await env.CADDINGTON_BUSINESS_DATA.prepare(
        `INSERT INTO entity_records (entity_type, source_system, external_id, record_date, data, import_batch_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          entityType,
          sourceSystem,
          externalId,
          recordDate,
          JSON.stringify(row),
          batchId
        )
        .run();
      processed++;
    } catch (error) {
      failed++;
      log("warn", "csv_row_import_failed", {
        row: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await env.CADDINGTON_BUSINESS_DATA.prepare(
    `UPDATE import_log SET status = 'completed', completed_at = datetime('now'),
     records_processed = ?, records_failed = ? WHERE id = ?`
  )
    .bind(processed, failed, batchId)
    .run();

  return json({
    ok: true,
    batchId,
    entityType,
    sourceSystem,
    recordsProcessed: processed,
    recordsFailed: failed,
  });
}

async function uploadKnowledgeDocument(
  request: Request,
  env: Env
): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();

  if (!(file instanceof File)) {
    return json({ error: "Multipart field 'file' is required." }, 400);
  }

  if (!env.CADDINGTON_KNOWLEDGE) {
    return json({ error: "R2 bucket is not configured on this deployment." }, 503);
  }

  const externalId =
    String(form.get("external_id") ?? "").trim() ||
    `doc-${crypto.randomUUID()}`;
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `documents/${externalId}/${safeName}`;
  const bytes = await file.arrayBuffer();
  const uploadMetadata = buildUploadMetadata(file.name, {
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
    isCurrent: String(form.get("is_current") ?? "").trim(),
  });

  await env.CADDINGTON_KNOWLEDGE.put(r2Key, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { external_id: externalId, title: title || file.name },
  });

  const insert = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO knowledge_documents (external_id, title, description, r2_key, mime_type, byte_size, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      externalId,
      title || file.name,
      description || null,
      r2Key,
      file.type || null,
      bytes.byteLength,
      JSON.stringify(uploadMetadata)
    )
    .run();

  const documentId = insert.meta.last_row_id;

  await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO knowledge_import_log (document_id, operation, status, completed_at, metadata)
     VALUES (?, 'upload', 'completed', datetime('now'), ?)`
  )
    .bind(documentId, JSON.stringify({ r2_key: r2Key }))
    .run();

  return json({
    ok: true,
    documentId,
    externalId,
    r2Key,
    byteSize: bytes.byteLength,
    indexUrl: `/admin/knowledge/${documentId}/index`,
  });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
