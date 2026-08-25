export type XeroProviderErrorBody = {
  status: number;
  code: string;
  message: string;
  detail?: string;
  retryAfterSeconds?: number;
  providerUnavailable?: boolean;
};

export function mapXeroHttpError(status: number, rawBody?: string): XeroProviderErrorBody {
  let detail = "";
  try {
    if (rawBody) {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      detail =
        String(parsed.detail ?? parsed.Detail ?? parsed.Message ?? parsed.message ?? "") ||
        rawBody.slice(0, 200);
    }
  } catch {
    detail = rawBody?.slice(0, 200) ?? "";
  }

  if (status === 401) {
    return {
      status,
      code: "XERO_AUTH_EXPIRED",
      message: "Xero authentication expired or insufficient scope.",
    };
  }
  if (status === 403) {
    return {
      status,
      code: "XERO_FORBIDDEN",
      message: "Xero denied access to that resource.",
    };
  }
  if (status === 404) {
    return {
      status,
      code: "XERO_NOT_FOUND",
      message: "The requested Xero record was not found.",
    };
  }
  if (status === 429) {
    return {
      status,
      code: "XERO_RATE_LIMITED",
      message: "Xero rate limit reached. Retry shortly.",
      retryAfterSeconds: 60,
    };
  }
  if (status >= 500) {
    return {
      status,
      code: "XERO_PROVIDER_UNAVAILABLE",
      message: "Xero is temporarily unavailable.",
      providerUnavailable: true,
    };
  }
  return {
    status,
    code: "XERO_REQUEST_FAILED",
    message: detail || `Xero request failed (${status}).`,
  };
}
