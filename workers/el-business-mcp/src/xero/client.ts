import { XERO_API_BASE } from "./config";
import { ElXeroError, sanitizeErrorMessage } from "./errors";
import { markApiCall } from "./store";

export type XeroClient = {
  tenantId: string;
  organisationName: string;
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  getAll<T>(path: string, collectionKey: string, query?: Record<string, string | number | boolean | undefined>, maxRecords?: number): Promise<T[]>;
};

function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(path.startsWith("http") ? path : `${XERO_API_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(
  db: D1Database,
  accessToken: string,
  tenantId: string,
  method: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
  body?: unknown
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(buildUrl(path, query), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? 0);
        lastError = new ElXeroError(
          `Xero rate-limited or unavailable (${response.status})`,
          response.status === 429 ? "EL_XERO_RATE_LIMITED" : "EL_XERO_UNAVAILABLE",
          response.status,
          true,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60
        );
        if (attempt < 4) {
          await pause(((lastError as ElXeroError).retryAfterSeconds ?? 1) * 250 * attempt);
          continue;
        }
        await markApiCall(db, false, (lastError as ElXeroError).message);
        throw lastError;
      }
      if (!response.ok) {
        const error = new ElXeroError(
          sanitizeErrorMessage(text.slice(0, 400) || `Xero HTTP ${response.status}`),
          response.status === 401 ? "EL_XERO_AUTH_EXPIRED" : "EL_XERO_API",
          response.status,
          false
        );
        await markApiCall(db, false, error.message);
        throw error;
      }
      await markApiCall(db, true, null);
      if (!text.trim()) return {} as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof ElXeroError) throw error;
      lastError = error;
      if (attempt >= 4) {
        const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
        await markApiCall(db, false, message);
        throw new ElXeroError(message, "EL_XERO_NETWORK", 502, true);
      }
      await pause(300 * attempt);
    }
  }
  throw lastError;
}

export function createXeroClient(input: {
  db: D1Database;
  accessToken: string;
  tenantId: string;
  organisationName: string;
}): XeroClient {
  return {
    tenantId: input.tenantId,
    organisationName: input.organisationName,
    get: (path, query) => requestJson(input.db, input.accessToken, input.tenantId, "GET", path, query),
    post: (path, body) => requestJson(input.db, input.accessToken, input.tenantId, "POST", path, undefined, body),
    getAll: async (path, collectionKey, query, maxRecords = 400) => {
      const items: unknown[] = [];
      let page = 1;
      while (items.length < maxRecords && page <= 8) {
        const payload = await requestJson<Record<string, unknown[]>>(
          input.db,
          input.accessToken,
          input.tenantId,
          "GET",
          path,
          { ...query, page, pageSize: 100 }
        );
        const batch = payload[collectionKey] ?? [];
        items.push(...batch);
        if (batch.length < 100) break;
        page += 1;
      }
      return items.slice(0, maxRecords) as never;
    },
  };
}
