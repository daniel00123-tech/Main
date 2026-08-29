/**
 * Short-lived per-isolate cache for safe repetitive reads.
 * Never use for permissions, confirmations, or financial write validation.
 */

type CacheEntry<T> = { value: T; expiresAt: number };

const store = new Map<string, CacheEntry<unknown>>();

export const SAFE_CACHE_SCOPES = [
  "platform_ops_health",
  "platform_ops_usage",
  "connector_catalogue",
] as const;

export type SafeCacheScope = (typeof SAFE_CACHE_SCOPES)[number];

export function isSafeCacheScope(scope: string): scope is SafeCacheScope {
  return (SAFE_CACHE_SCOPES as readonly string[]).includes(scope);
}

export async function rememberSafeRead<T>(
  scope: SafeCacheScope,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!isSafeCacheScope(scope)) {
    return loader();
  }
  const cacheKey = `${scope}:${key}`;
  const now = Date.now();
  const existing = store.get(cacheKey) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    return existing.value;
  }
  const value = await loader();
  store.set(cacheKey, { value, expiresAt: now + Math.max(1, ttlMs) });
  return value;
}

export function clearSafeReadCache(scope?: SafeCacheScope): void {
  if (!scope) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(`${scope}:`)) store.delete(key);
  }
}
