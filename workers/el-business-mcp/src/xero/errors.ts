export class ElXeroError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly retryable = false,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ElXeroError";
  }
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/client_secret=[^&\s]+/gi, "client_secret=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[redacted]"')
    .replace(/refresh_token=[^&\s]+/gi, "refresh_token=[redacted]")
    .replace(/code=[A-Za-z0-9._~-]+/gi, "code=[redacted]");
}

export function toolErrorPayload(error: unknown): { error: string; code: string } {
  if (error instanceof ElXeroError) {
    return { error: sanitizeErrorMessage(error.message), code: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: sanitizeErrorMessage(message), code: "EL_XERO_UNEXPECTED" };
}
