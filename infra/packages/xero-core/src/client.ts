import { XERO_AUTH, XERO_DATA_BOUNDS } from "@infra/shared";

export type XeroClientConfig = {
  accessToken: string;
  tenantId: string;
  apiBaseUrl?: string;
};

export class XeroApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "XeroApiError";
  }
}

export class XeroClient {
  private readonly baseUrl: string;

  constructor(private readonly config: XeroClientConfig) {
    this.baseUrl = config.apiBaseUrl ?? XERO_AUTH.apiBaseUrl;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      Accept: "application/json",
      "Xero-Tenant-Id": this.config.tenantId,
    };
  }

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const response = await fetch(url.toString(), { headers: this.headers() });
    if (!response.ok) {
      throw new XeroApiError(`Xero API ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new XeroApiError(`Xero API ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new XeroApiError(`Xero API ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  clampLimit(limit?: number): number {
    const value = limit ?? XERO_DATA_BOUNDS.defaultListResults;
    return Math.min(Math.max(1, value), XERO_DATA_BOUNDS.maxListResults);
  }
}
