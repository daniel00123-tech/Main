import { XERO_AUTH } from "@infra/shared";
import { XeroApiError } from "./client";
import { mapXeroHttpError } from "./errors";

export type XeroFetchConfig = {
  accessToken: string;
  tenantId: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

function xeroHeaders(config: XeroFetchConfig): HeadersInit {
  return {
    Authorization: `Bearer ${config.accessToken}`,
    "Xero-tenant-id": config.tenantId,
    Accept: "application/json",
  };
}

export function buildXeroUrl(
  apiBaseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, `${apiBaseUrl.replace(/\/$/, "")}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function xeroGetJson<T>(
  config: XeroFetchConfig,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
  options?: { headers?: Record<string, string> },
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = buildXeroUrl(config.apiBaseUrl ?? XERO_AUTH.apiBaseUrl, path, query);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { ...xeroHeaders(config), ...(options?.headers ?? {}) },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new XeroApiError({
      status: 503,
      code: "XERO_PROVIDER_UNAVAILABLE",
      message: "Unable to reach Xero.",
      detail,
      providerUnavailable: true,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    const mapped = mapXeroHttpError(response.status, text);
    throw new XeroApiError(mapped);
  }
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new XeroApiError({
      status: 502,
      code: "XERO_MALFORMED_RESPONSE",
      message: "Xero returned a malformed response.",
      detail: text.slice(0, 200),
    });
  }
}

export async function xeroPostJson<T>(
  config: XeroFetchConfig,
  path: string,
  body: unknown,
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = buildXeroUrl(config.apiBaseUrl ?? XERO_AUTH.apiBaseUrl, path);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { ...xeroHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new XeroApiError({
      status: 503,
      code: "XERO_PROVIDER_UNAVAILABLE",
      message: "Unable to reach Xero.",
      detail,
      providerUnavailable: true,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    const mapped = mapXeroHttpError(response.status, text);
    throw new XeroApiError(mapped);
  }
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new XeroApiError({
      status: 502,
      code: "XERO_MALFORMED_RESPONSE",
      message: "Xero returned a malformed response.",
      detail: text.slice(0, 200),
    });
  }
}
