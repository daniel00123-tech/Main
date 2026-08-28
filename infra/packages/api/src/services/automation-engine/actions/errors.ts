export class AutomationActionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
    readonly result?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AutomationActionError";
  }
}
