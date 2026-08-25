export const CONNECTOR_ERROR_CODES = {
  AUTH_EXPIRED: "CONNECTOR_AUTH_EXPIRED",
  PROVIDER_UNAVAILABLE: "CONNECTOR_PROVIDER_UNAVAILABLE",
  CONFIG_INCOMPLETE: "CONNECTOR_CONFIG_INCOMPLETE",
  SYNC_FAILED: "CONNECTOR_SYNC_FAILED",
  PERMISSION_DENIED: "CONNECTOR_PERMISSION_DENIED",
  SUSPENDED: "CONNECTOR_SUSPENDED",
  CREDENTIAL_SUBMISSION_DISABLED: "CREDENTIAL_SUBMISSION_DISABLED",
  CREDENTIAL_REF_FORBIDDEN: "CREDENTIAL_REF_FORBIDDEN",
  CREDENTIAL_CRYPTO_FAILED: "CREDENTIAL_CRYPTO_FAILED",
  COMPANY_INACTIVE: "CONNECTOR_COMPANY_INACTIVE",
  OAUTH_NOT_ACTIVATED: "OAUTH_NOT_ACTIVATED",
  OAUTH_STATE_INVALID: "OAUTH_STATE_INVALID",
  OAUTH_APP_NOT_CONFIGURED: "OAUTH_APP_NOT_CONFIGURED",
  OAUTH_PROVIDER_DENIED: "OAUTH_PROVIDER_DENIED",
  CONNECTOR_NOT_CONNECTED: "CONNECTOR_NOT_CONNECTED",
  XERO_MCP_UNAVAILABLE: "XERO_MCP_UNAVAILABLE",
  FINANCIAL_WRITES_DISABLED: "FINANCIAL_WRITES_DISABLED",
} as const;

export type ConnectorErrorCode =
  (typeof CONNECTOR_ERROR_CODES)[keyof typeof CONNECTOR_ERROR_CODES];

export const CUSTOMER_ERROR_MESSAGES: Record<ConnectorErrorCode, string> = {
  CONNECTOR_AUTH_EXPIRED: "Authentication expired",
  CONNECTOR_PROVIDER_UNAVAILABLE: "Provider unavailable",
  CONNECTOR_CONFIG_INCOMPLETE: "Configuration incomplete",
  CONNECTOR_SYNC_FAILED: "Sync failed",
  CONNECTOR_PERMISSION_DENIED: "Permission denied",
  CONNECTOR_SUSPENDED: "Company is suspended",
  CREDENTIAL_SUBMISSION_DISABLED:
    "Secure credential storage is not configured.",
  CREDENTIAL_REF_FORBIDDEN: "That credential cannot be used for this company",
  CREDENTIAL_CRYPTO_FAILED: "The credential could not be processed",
  CONNECTOR_COMPANY_INACTIVE:
    "This company cannot store or use credentials in its current state",
  OAUTH_NOT_ACTIVATED: "OAuth for this connector is prepared but not activated",
  OAUTH_STATE_INVALID: "The sign-in request expired or was not recognised",
  OAUTH_APP_NOT_CONFIGURED:
    "The Xero application is not configured. Connect Xero stays disabled until the Client ID and Client Secret are set.",
  OAUTH_PROVIDER_DENIED: "Xero did not complete authorisation",
  CONNECTOR_NOT_CONNECTED: "Xero is not connected for this company",
  XERO_MCP_UNAVAILABLE:
    "This company Business MCP does not yet expose that Xero tool",
  FINANCIAL_WRITES_DISABLED: "Financial writes are not enabled",
};

export function customerConnectorError(code: ConnectorErrorCode): {
  code: ConnectorErrorCode;
  error: string;
} {
  return { code, error: CUSTOMER_ERROR_MESSAGES[code] };
}
