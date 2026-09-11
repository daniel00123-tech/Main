export class NotConfiguredError extends Error {
  readonly code = "not_configured" as const;

  constructor(
    readonly resource: string,
    message?: string
  ) {
    super(message ?? `${resource} is not configured for this company MCP.`);
    this.name = "NotConfiguredError";
  }
}

export class NotConnectedError extends Error {
  readonly code = "not_connected" as const;

  constructor(
    readonly connector: string,
    message?: string
  ) {
    super(message ?? `${connector} is not connected for this company MCP.`);
    this.name = "NotConnectedError";
  }
}

export class InsufficientEvidenceError extends Error {
  readonly code = "insufficient_evidence" as const;

  constructor(message = "Insufficient company evidence to answer confidently.") {
    super(message);
    this.name = "InsufficientEvidenceError";
  }
}

export class UnauthorizedError extends Error {
  readonly code = "unauthorized" as const;

  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export type CoreErrorCode =
  | "not_configured"
  | "not_connected"
  | "unavailable"
  | "insufficient_evidence"
  | "unauthorized";

export interface CoreErrorResponse {
  status: CoreErrorCode;
  message: string;
  resource?: string;
  connector?: string;
}

export function toCoreErrorResponse(error: unknown): CoreErrorResponse {
  if (error instanceof NotConfiguredError) {
    return {
      status: "not_configured",
      message: error.message,
      resource: error.resource,
    };
  }
  if (error instanceof NotConnectedError) {
    return {
      status: "not_connected",
      message: error.message,
      connector: error.connector,
    };
  }
  if (error instanceof InsufficientEvidenceError) {
    return {
      status: "insufficient_evidence",
      message: error.message,
    };
  }
  if (error instanceof UnauthorizedError) {
    return {
      status: "unauthorized",
      message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: "unavailable", message };
}
