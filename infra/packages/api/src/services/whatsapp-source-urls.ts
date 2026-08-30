import type { Env } from "../env";
import { firstHttpUrl } from "./mcp-knowledge-standard";

export type KnowledgeSourceUrlHit = {
  title: string;
  url: string;
  sourceType: string | null;
  knowledgeDocumentId: number | null;
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

/**
 * Safe metadata-only lookup. Does not download or re-OCR content.
 * Matches existing Caddington / Microsoft knowledge rows that already store web_url.
 */
export async function lookupKnowledgeSourceUrl(
  env: Env,
  companyId: string,
  title: string,
): Promise<KnowledgeSourceUrlHit | null> {
  const needle = normalizeDocumentTitle(title);
  if (!needle || !companyId) return null;
  const like = `%${needle.split(" ").slice(0, 4).join("%")}%`;
  try {
    const rows = await env.DB.prepare(
      `SELECT title, web_url, source_type, knowledge_document_id, provenance_json
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
      .all<{
        title: string;
        web_url: string | null;
        source_type: string | null;
        knowledge_document_id: number | null;
        provenance_json: string | null;
      }>();

    for (const row of rows.results ?? []) {
      if (!titlesLikelyMatch(title, row.title) && !PRIORITY_TITLES.some((p) => needle.includes(p) && normalizeDocumentTitle(row.title).includes(p))) {
        continue;
      }
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
      const url = firstHttpUrl(row.web_url, provenanceUrl);
      if (url) {
        return {
          title: row.title,
          url,
          sourceType: row.source_type,
          knowledgeDocumentId: row.knowledge_document_id,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
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
