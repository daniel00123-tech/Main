-- Tenant-native Microsoft application registry (Option B).
-- Stores public tenant/client IDs and a Cloudflare secret binding name only.
-- Never store the raw client secret in D1.

CREATE TABLE IF NOT EXISTS microsoft_tenant_identities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'microsoft',
  display_name TEXT,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  secret_binding TEXT NOT NULL,
  auth_mode TEXT NOT NULL DEFAULT 'client_credentials',
  active INTEGER NOT NULL DEFAULT 1,
  configured_at TEXT NOT NULL,
  last_token_success TEXT,
  last_error TEXT,
  UNIQUE(company_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_ms_tenant_identities_company
  ON microsoft_tenant_identities(company_id, active);

INSERT OR IGNORE INTO microsoft_tenant_identities (
  id, company_id, provider, display_name, tenant_id, client_id, secret_binding,
  auth_mode, active, configured_at, last_token_success, last_error
) VALUES (
  'mti_co_el_microsoft',
  'co_el',
  'microsoft',
  'INFRA - Elvex MCP',
  'af32e619-3647-44a2-85d9-1c45457c0e91',
  'f8ec6a91-f043-4f63-8800-64135af48c4e',
  'EL_MS_CLIENT_SECRET',
  'client_credentials',
  1,
  '2026-09-04T21:00:00.000Z',
  NULL,
  NULL
);
