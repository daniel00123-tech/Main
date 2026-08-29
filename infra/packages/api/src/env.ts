export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  SESSION_SECRET: string;
  ALLOWED_ORIGINS: string;
  COOKIE_CROSS_ORIGIN?: string;
  INITIAL_PLATFORM_ADMIN_EMAIL?: string;
  INITIAL_PLATFORM_ADMIN_PASSWORD?: string;
  /** Optional MCP auth secret referenced by mcp_environments.auth_secret_ref */
  CADDINGTON_MCP_AUTH_TOKEN?: string;
  HT_MCP_AUTH_TOKEN?: string;
  EL_MCP_AUTH_TOKEN?: string;
  /** Optional service bindings for same-account company MCP Workers */
  CADDINGTON_MCP?: Fetcher;
  HT_BUSINESS_MCP?: Fetcher;
  EL_BUSINESS_MCP?: Fetcher;
  /** Stripe secrets — set via wrangler secret put when ready */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Public API base URL for generated links and OAuth defaults (no trailing slash) */
  INFRA_PUBLIC_API_URL?: string;
  /** Public MCP hostname (no trailing slash). Canonical: https://mcp.infrastack.app */
  INFRA_PUBLIC_MCP_URL?: string;
  /** Canonical customer/admin portal origin, e.g. https://app.infrastack.app */
  PORTAL_PUBLIC_ORIGIN?: string;
  /** Portal host domain for legacy company subdomains, e.g. infra-web.pages.dev */
  PORTAL_BASE_DOMAIN?: string;
  /**
   * Optional cookie Domain for legacy pages.dev company subdomains only.
   * Do not set .infrastack.app — app.infrastack.app uses host-only cookies.
   */
  PORTAL_COOKIE_DOMAIN?: string;
  /** Envelope-encryption wrapping key for connector credentials. Never store in D1. */
  INFRA_CREDENTIAL_WRAPPING_KEY?: string;
  INFRA_CREDENTIAL_KEY_VERSION?: string;
  /** Xero app credentials — Worker secrets only. Never store in D1. */
  XERO_CLIENT_ID?: string;
  XERO_CLIENT_SECRET?: string;
  /** Optional email delivery via Resend */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Feature flag — auto top-up execution (test mode only until operator approval) */
  AUTO_TOPUP_EXECUTION_ENABLED?: string;
  /** Microsoft 365 app registration — Worker secrets only */
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REDIRECT_URI?: string;
  /** When true, use platform multitenant Entra app; tenant ID comes from connector instance after admin consent */
  MICROSOFT_MULTITENANT_APP?: string;
  /** Per-company MCP admin tokens for knowledge bridge (e.g. CADDINGTON_ADMIN_TOKEN, HT_BUSINESS_MCP_ADMIN_TOKEN) */
  CADDINGTON_ADMIN_TOKEN?: string;
  HT_BUSINESS_MCP_ADMIN_TOKEN?: string;
  EL_BUSINESS_MCP_ADMIN_TOKEN?: string;
  /** Azure AI Document Intelligence — OCR fallback for requires_ocr documents */
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?: string;
  AZURE_DOCUMENT_INTELLIGENCE_KEY?: string;
  AZURE_OCR_MAX_PAGES?: string;
  AZURE_OCR_MAX_BYTES?: string;
  /** Cloudflare Queue for Microsoft file ingestion (one file per message) */
  MICROSOFT_KNOWLEDGE_QUEUE?: Queue<import("./services/microsoft-queue").MicrosoftFileJobMessage>;
  /** Cloudflare Queue for automation run execution */
  AUTOMATION_RUN_QUEUE?: Queue<import("./services/automation-engine/queue").AutomationRunMessage>;
  /** Safe send UAT — requires XERO_SEND_UAT_MODE=true simultaneously */
  XERO_SEND_UAT_MODE?: string;
  XERO_SEND_TEST_RECIPIENT?: string;
  [key: string]: unknown;
}

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    // Temporary company-subdomain fallback on Pages. Not a production wildcard.
    if (protocol === "https:" && hostname.endsWith(".infra-web.pages.dev")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
