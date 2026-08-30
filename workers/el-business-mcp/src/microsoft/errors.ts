import { AuthorizationError } from "../rbac/errors";

export class ElMicrosoftError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly retryable = false
  ) {
    super(message);
    this.name = "ElMicrosoftError";
  }
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/client_secret=[^&\s]+/gi, "client_secret=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[redacted]"');
}

export function toolErrorPayload(error: unknown): { error: string; code: string } {
  if (error instanceof ElMicrosoftError) {
    return { error: sanitizeErrorMessage(error.message), code: error.code };
  }
  if (error instanceof AuthorizationError) {
    return { error: sanitizeErrorMessage(error.message), code: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: sanitizeErrorMessage(message), code: "EL_MS_UNEXPECTED" };
}
