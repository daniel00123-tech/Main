import type { KnowledgeSearchResponse } from "./knowledge-search";

interface CacheEntry {
  generation: string;
  expiresAt: number;
  response: KnowledgeSearchResponse;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 128;
const cache = new Map<string, CacheEntry>();

export async function getKnowledgeIndexGeneration(env: {
  CADDINGTON_BUSINESS_DATA: D1Database;
}): Promise<string> {
  const row = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `SELECT MAX(updated_at) AS generation
     FROM knowledge_documents
     WHERE status = 'indexed'`
  ).first<{ generation: string | null }>();
  return row?.generation ?? "0";
}

export function buildSearchCacheKey(
  query: string,
  options: Record<string, unknown>
): string {
  return JSON.stringify({ query: query.trim().toLowerCase(), options });
}

export function readSearchCache(
  key: string,
  generation: string
): KnowledgeSearchResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.generation !== generation) {
    cache.delete(key);
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.response;
}

export function writeSearchCache(
  key: string,
  generation: string,
  response: KnowledgeSearchResponse
): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, {
    generation,
    expiresAt: Date.now() + CACHE_TTL_MS,
    response,
  });
}

export function clearSearchCache(): void {
  cache.clear();
}
