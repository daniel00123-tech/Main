import type { ElMicrosoftConfig } from "./config";
import { acquireGraphToken } from "./auth";
import { ElMicrosoftError, sanitizeErrorMessage } from "./errors";

export type GraphClient = {
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  delete(path: string, init?: RequestInit): Promise<void>;
  getAll<T>(path: string, maxPages?: number): Promise<T[]>;
  getBytes(path: string): Promise<{ bytes: ArrayBuffer; contentType: string | null }>;
};

export type GraphPage<T> = {
  value?: T[];
  "@odata.nextLink"?: string;
};

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function graphFetch(
  config: ElMicrosoftConfig,
  accessToken: string,
  path: string,
  init: RequestInit | undefined,
  attempt: number
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${config.graphBaseUrl}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  const response = await fetch(url, { ...init, headers });

  if (response.status === 429 && attempt < 4) {
    const retryAfterMs = parseRetryAfterMs(response) ?? 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return graphFetch(config, accessToken, path, init, attempt + 1);
  }

  return response;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return sanitizeErrorMessage(body.slice(0, 400) || `HTTP ${response.status}`);
}

export async function createGraphClient(config: ElMicrosoftConfig): Promise<GraphClient> {
  const token = await acquireGraphToken(config);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await graphFetch(config, token.accessToken, path, init, 0);
    if (response.status === 204) return {} as T;
    if (!response.ok) {
      throw new ElMicrosoftError(
        await readError(response),
        "EL_MS_GRAPH_ERROR",
        response.status,
        response.status === 429 || response.status >= 500
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return {} as T;
    return (await response.json()) as T;
  }

  return {
    get: (path, init) => request(path, { ...init, method: "GET" }),
    post: (path, body, init) =>
      request(path, {
        ...init,
        method: "POST",
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    patch: (path, body, init) =>
      request(path, {
        ...init,
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    delete: async (path, init) => {
      await request(path, { ...init, method: "DELETE" });
    },
    getAll: async <T>(path: string, maxPages = 20): Promise<T[]> => {
      const items: T[] = [];
      let next: string | undefined = path;
      let pages = 0;
      while (next && pages < maxPages) {
        const page: GraphPage<T> = await request<GraphPage<T>>(next);
        items.push(...(page.value ?? []));
        next = page["@odata.nextLink"];
        pages += 1;
      }
      return items;
    },
    getBytes: async (path) => {
      const response = await graphFetch(config, token.accessToken, path, { method: "GET" }, 0);
      if (!response.ok) {
        throw new ElMicrosoftError(
          await readError(response),
          "EL_MS_GRAPH_ERROR",
          response.status,
          response.status === 429 || response.status >= 500
        );
      }
      return {
        bytes: await response.arrayBuffer(),
        contentType: response.headers.get("content-type"),
      };
    },
  };
}
