import { XERO_AUTH, XERO_DATA_BOUNDS } from "@infra/shared";
import { mapXeroHttpError, type XeroProviderErrorBody } from "./errors";

export type XeroClientConfig = {
  accessToken: string;
  tenantId: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class XeroApiError extends Error {
  readonly provider: XeroProviderErrorBody;

  constructor(provider: XeroProviderErrorBody) {
    super(provider.message);
    this.name = "XeroApiError";
    this.provider = provider;
  }
}

export class XeroClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: XeroClientConfig) {
    this.baseUrl = config.apiBaseUrl ?? XERO_AUTH.apiBaseUrl;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      Accept: "application/json",
      "Xero-tenant-id": this.config.tenantId,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(normalizedPath, `${this.baseUrl.replace(/\/$/, "")}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    try {
      const init: RequestInit = {
        method,
        headers: body
          ? { ...this.headers(), "Content-Type": "application/json" }
          : this.headers(),
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const response = await this.fetchImpl(url.toString(), init);
      const text = await response.text();
      if (!response.ok) {
        throw new XeroApiError(mapXeroHttpError(response.status, text));
      }
      if (!text.trim()) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new XeroApiError({
          status: 502,
          code: "XERO_MALFORMED_RESPONSE",
          message: "Xero returned a malformed response.",
        });
      }
    } catch (error) {
      if (error instanceof XeroApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new XeroApiError({
          status: 504,
          code: "XERO_TIMEOUT",
          message: "Xero request timed out.",
          providerUnavailable: true,
        });
      }
      throw new XeroApiError({
        status: 503,
        code: "XERO_PROVIDER_UNAVAILABLE",
        message: "Unable to reach Xero.",
        detail: error instanceof Error ? error.message : String(error),
        providerUnavailable: true,
      });
    } finally {
      /* timeout cleared */
    }
  }

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, undefined, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, undefined, body);
  }

  clampLimit(limit?: number): number {
    const value = limit ?? XERO_DATA_BOUNDS.defaultListResults;
    return Math.min(Math.max(1, value), XERO_DATA_BOUNDS.maxListResults);
  }

  maxPages(): number {
    return Math.ceil(XERO_DATA_BOUNDS.maxPaginationRecords / 100);
  }
}

export { mapXeroHttpError };
