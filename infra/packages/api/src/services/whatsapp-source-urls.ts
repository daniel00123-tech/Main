import type { Env } from "../env";
import { firstHttpUrl } from "./mcp-knowledge-standard";

export type KnowledgeSourceUrlHit = {
  title: string;
  url: string;
  sourceType: string | null;
  knowledgeDocumentId: number | null;
  externalItemId?: string | null;
  matchReason: "provider_item" | "knowledge_document" | "source_key" | "path" | "exact_title" | "unique_title";
};

export type SourceUrlHint = {
  title?: string | null;
  entityId?: string | null;
  externalItemId?: string | null;
  knowledgeDocumentId?: number | string | null;
  sourceKey?: string | null;
  path?: string | null;
};

const PRIORITY_TITLES = ["coal search", "arnold crescent"];

export function normalizeDocumentTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\.(pdf|docx?|xlsx?|pptx?)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function titlesLikelyMatch(left: string, right: string): boolean {
  const a = normalizeDocumentTitle(left);
  const b = normalizeDocumentTitle(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function titlesExactlyMatch(left: string, right: string): boolean {
  const a = normalizeDocumentTitle(left);
  const b = normalizeDocumentTitle(right);
  return Boolean(a && b && a === b);
}

type KnowledgeRow = {
  title: string;
  web_url: string | null;
  source_type: string | null;
  knowledge_document_id: number | null;
  provenance_json: string | null;
  external_item_id?: string | null;
  path?: string | null;
};

function urlFromRow(row: KnowledgeRow): string {
  let provenanceUrl = "";
  try {
    const provenance = row.provenance_json ? (JSON.parse(row.provenance_json) as Record<string, unknown>) : {};
    provenanceUrl = firstHttpUrl(
      provenance.webUrl,
      provenance.web_url,
      provenance.webViewLink,
      provenance.web_view_link,
      provenance.webLink,
      provenance.sourceUrl,
    );
  } catch {
    provenanceUrl = "";
  }
  return firstHttpUrl(row.web_url, provenanceUrl);
}

function toHit(row: KnowledgeRow, matchReason: KnowledgeSourceUrlHit["matchReason"]): KnowledgeSourceUrlHit | null {
  const url = urlFromRow(row);
  if (!url) return null;
  return {
    title: row.title,
    url,
    sourceType: row.source_type,
    knowledgeDocumentId: row.knowledge_document_id,
    externalItemId: row.external_item_id ?? null,
    matchReason,
  };
}

function asHint(titleOrHint: string | SourceUrlHint): SourceUrlHint {
  return typeof titleOrHint === "string" ? { title: titleOrHint } : titleOrHint;
}

/**
 * Safe metadata-only lookup. Does not download or re-OCR content.
 * Prefers provider item / document identity over ambiguous title matches.
 */
export async function lookupKnowledgeSourceUrl(
  env: Env,
  companyId: string,
  titleOrHint: string | SourceUrlHint,
): Promise<KnowledgeSourceUrlHit | null> {
  const hint = asHint(titleOrHint);
  if (!companyId) return null;

  const byIdentity = await lookupByIdentity(env, companyId, hint);
  if (byIdentity) return byIdentity;

  const byJob = await lookupFileJobUrl(env, companyId, hint);
  if (byJob) return byJob;

  return lookupByTitle(env, companyId, hint);
}

async function lookupByIdentity(
  env: Env,
  companyId: string,
  hint: SourceUrlHint,
): Promise<KnowledgeSourceUrlHit | null> {
  const providerId = firstNonEmpty(hint.externalItemId, hint.entityId);
  if (providerId && providerId.length >= 6 && !/\s/.test(providerId)) {
    const row = await queryKnowledge(env, companyId, {
      sql: `AND (external_item_id = ? OR CAST(knowledge_document_id AS TEXT) = ?)`,
      args: [providerId, providerId],
    });
    const hit = row ? toHit(row, "provider_item") : null;
    if (hit) return hit;
  }

  const knowledgeId = hint.knowledgeDocumentId != null ? String(hint.knowledgeDocumentId).trim() : "";
  if (knowledgeId && /^\d+$/.test(knowledgeId)) {
    const row = await queryKnowledge(env, companyId, {
      sql: `AND CAST(knowledge_document_id AS TEXT) = ?`,
      args: [knowledgeId],
    });
    const hit = row ? toHit(row, "knowledge_document") : null;
    if (hit) return hit;
  }

  const sourceKey = firstNonEmpty(hint.sourceKey);
  if (sourceKey) {
    const row = await queryKnowledge(env, companyId, {
      sql: `AND (external_item_id = ? OR path = ?)`,
      args: [sourceKey, sourceKey],
    });
    const hit = row ? toHit(row, "source_key") : null;
    if (hit) return hit;
  }

  const path = firstNonEmpty(hint.path);
  if (path && path.includes("/")) {
    const row = await queryKnowledge(env, companyId, {
      sql: `AND path = ?`,
      args: [path],
    });
    const hit = row ? toHit(row, "path") : null;
    if (hit) return hit;
  }
  return null;
}

async function lookupFileJobUrl(
  env: Env,
  companyId: string,
  hint: SourceUrlHint,
): Promise<KnowledgeSourceUrlHit | null> {
  const providerId = firstNonEmpty(hint.externalItemId, hint.entityId);
  try {
    if (providerId && providerId.length >= 6 && !/\s/.test(providerId)) {
      const row = await env.DB.prepare(
        `SELECT file_name, web_url, external_item_id, relative_path
         FROM microsoft_file_jobs
         WHERE company_id = ?
           AND web_url IS NOT NULL
           AND web_url LIKE 'http%'
           AND external_item_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
        .bind(companyId, providerId)
        .first<{ file_name: string; web_url: string | null; external_item_id: string | null; relative_path?: string | null }>();
      if (row?.web_url && /^https?:\/\//i.test(row.web_url)) {
        return {
          title: row.file_name,
          url: row.web_url,
          sourceType: "microsoft",
          knowledgeDocumentId: null,
          externalItemId: row.external_item_id,
          matchReason: "provider_item",
        };
      }
    }
  } catch {
    // file_jobs is optional metadata — never fail the chat path.
  }
  return null;
}

async function lookupByTitle(
  env: Env,
  companyId: string,
  hint: SourceUrlHint,
): Promise<KnowledgeSourceUrlHit | null> {
  const title = String(hint.title ?? "").trim();
  const needle = normalizeDocumentTitle(title);
  if (!needle) return null;
  const like = `%${needle.split(" ").slice(0, 4).join("%")}%`;
  try {
    const rows = await env.DB.prepare(
      `SELECT title, web_url, source_type, knowledge_document_id, provenance_json, external_item_id, path
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') != 'tombstoned'
         AND web_url IS NOT NULL
         AND web_url LIKE 'http%'
         AND LOWER(title) LIKE ?
       ORDER BY updated_at DESC
       LIMIT 8`,
    )
      .bind(companyId, like)
      .all<KnowledgeRow>();

    const matches = (rows.results ?? []).filter((row) => titlesLikelyMatch(title, row.title));
    const exact = matches.filter((row) => titlesExactlyMatch(title, row.title));
    if (exact.length === 1) return toHit(exact[0]!, "exact_title");
    if (exact.length > 1) return null;

    if (matches.length === 1) return toHit(matches[0]!, "unique_title");

    const priority = matches.filter((row) =>
      PRIORITY_TITLES.some((p) => needle.includes(p) && normalizeDocumentTitle(row.title).includes(p)),
    );
    if (priority.length === 1) return toHit(priority[0]!, "unique_title");
  } catch {
    return null;
  }
  return null;
}

async function queryKnowledge(
  env: Env,
  companyId: string,
  input: { sql: string; args: unknown[] },
): Promise<KnowledgeRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT title, web_url, source_type, knowledge_document_id, provenance_json, external_item_id, path
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') != 'tombstoned'
         ${input.sql}
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
      .bind(companyId, ...input.args)
      .first<KnowledgeRow>();
  } catch {
    return null;
  }
}

export async function backfillPriorityKnowledgeSourceUrls(
  env: Env,
  companyId: string,
): Promise<{ attempted: number; filled: number }> {
  let attempted = 0;
  let filled = 0;
  for (const title of ["Coal Search.pdf", "Arnold Crescent"]) {
    attempted += 1;
    const hit = await lookupKnowledgeSourceUrl(env, companyId, title);
    if (hit?.url) filled += 1;
  }
  return { attempted, filled };
}

export function enrichUrlFromHit(
  existing: string | null | undefined,
  extra: Record<string, unknown> | null | undefined,
): string {
  return firstHttpUrl(
    existing,
    extra?.url,
    extra?.webUrl,
    extra?.web_url,
    extra?.webViewLink,
    extra?.web_view_link,
    extra?.webLink,
    extra?.web_link,
    extra?.sourceUrl,
    extra?.source_url,
    extra?.canonicalUrl,
    extra?.canonical_url,
  );
}

export function identityFromMetadata(extra: Record<string, unknown> | null | undefined): {
  providerItemId: string | null;
  sourceKey: string | null;
  path: string | null;
  sourceSystem: string | null;
} {
  if (!extra) {
    return { providerItemId: null, sourceKey: null, path: null, sourceSystem: null };
  }
  const providerItemId = firstNonEmpty(
    extra.external_item_id,
    extra.externalItemId,
    extra.external_id,
    extra.externalId,
    extra.providerItemId,
    extra.itemId,
  );
  const sourceKey = firstNonEmpty(extra.source_key, extra.sourceKey, extra.canonicalKey, extra.id);
  const path = firstNonEmpty(extra.path, extra.relative_path, extra.relativePath);
  const sourceSystem = firstNonEmpty(
    extra.source_type,
    extra.sourceType,
    extra.source_system,
    extra.sourceSystem,
    extra.source,
  );
  return { providerItemId, sourceKey, path, sourceSystem };
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
