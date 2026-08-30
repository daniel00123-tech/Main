export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly code: string = "EL_RBAC_DENIED",
    readonly status = 403,
    readonly capability?: string,
    readonly resource?: string
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}
