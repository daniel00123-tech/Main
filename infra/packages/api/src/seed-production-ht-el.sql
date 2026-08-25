-- Attach existing HT Business MCP and EL Business MCP as live INFRA tenants.
-- Does NOT create Workers, D1 databases, or replacement MCPs.
-- Auth secret refs only — never plaintext tokens.
-- Idempotent: INSERT OR IGNORE / INSERT OR REPLACE on stable IDs.

-- HT Business
INSERT OR IGNORE INTO companies (
  id, slug, name, status, primary_domain, notes,
  trading_name, country, timezone,
  portal_subdomain, portal_hostname, provisioned_at,
  created_at, updated_at
) VALUES (
  'co_ht',
  'ht-business',
  'HT Business',
  'active',
  NULL,
  'Existing HT Business MCP attached. Knowledge (R2/Vectorize) not configured. Warehouse/D1 present.',
  'HT Business',
  'GB',
  'Europe/London',
  'ht',
  'ht.infra-web.pages.dev',
  datetime('now'),
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO credit_balances
  (company_id, balance_cents, currency, low_balance_threshold_cents, updated_at)
VALUES ('co_ht', 0, 'GBP', 500, datetime('now'));

INSERT OR IGNORE INTO company_commercial_settings (
  company_id, currency, target_gross_margin_percent, minimum_charge_cents,
  monthly_platform_fee_cents, included_credit_cents, low_balance_threshold_cents,
  auto_top_up_enabled, billing_status, pricing_plan, updated_at
) VALUES ('co_ht', 'GBP', 60, 1, 0, 1000, 500, 0, 'active', 'standard', datetime('now'));

INSERT OR IGNORE INTO company_modules
  (id, company_id, module_key, status, config_json, created_at, updated_at)
VALUES
  ('mod_ht_knowledge', 'co_ht', 'knowledge', 'available', '{}', datetime('now'), datetime('now')),
  ('mod_ht_chatgpt', 'co_ht', 'chatgpt', 'available', '{}', datetime('now'), datetime('now')),
  ('mod_ht_claude', 'co_ht', 'claude', 'available', '{}', datetime('now'), datetime('now')),
  ('mod_ht_whatsapp', 'co_ht', 'whatsapp', 'available', '{}', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO ai_client_connections
  (id, company_id, client_type, display_name, status, gateway_path, setup_notes, created_at, updated_at)
VALUES
  ('ai_co_ht_chatgpt', 'co_ht', 'chatgpt', 'ChatGPT', 'ready_to_connect', '/api/gateway/v1/mcp',
   'Generate a service identity token, then configure ChatGPT to call the INFRA MCP facade with the Bearer token. Do not point ChatGPT at the company MCP directly.',
   datetime('now'), datetime('now')),
  ('ai_co_ht_claude', 'co_ht', 'claude', 'Claude', 'coming_soon', '/api/gateway/v1/mcp',
   'Claude connector is coming soon.', datetime('now'), datetime('now')),
  ('ai_co_ht_whatsapp', 'co_ht', 'whatsapp', 'WhatsApp', 'coming_soon', '/api/gateway/v1/mcp',
   'WhatsApp channel gateway is planned for a later phase.', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO ledger_entries (
  id, company_id, entry_type, amount_cents, currency, balance_after_cents,
  reference_type, reference_id, description, metadata_json, created_by, created_at
) VALUES (
  'ledger_ht_opening_test',
  'co_ht',
  'promotional_credit',
  1000,
  'GBP',
  1000,
  'provisioning',
  'opening_co_ht',
  '£10.00 TEST CREDIT (internal/test) for HT Business',
  '{"provisioned":true,"testCredit":true,"label":"TEST CREDIT"}',
  'infra-system',
  datetime('now')
);

UPDATE credit_balances
SET balance_cents = (
  SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries WHERE company_id = 'co_ht'
), updated_at = datetime('now')
WHERE company_id = 'co_ht';

INSERT OR IGNORE INTO mcp_environments (
  id, company_id, name, description, endpoint_url, transport, status,
  enabled, is_external, data_plane_id, mcp_version, business_mcp_core_version,
  capabilities_json, auth_secret_ref, service_binding_ref,
  last_health_check_at, last_healthy_at, health_message,
  created_at, updated_at
) VALUES (
  'mcp_ht_primary',
  'co_ht',
  'HT Business MCP',
  'Existing HT Business MCP Worker. Knowledge not configured; structured warehouse data lives in ht-business-data.',
  'https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp',
  'streamable-http',
  'registered',
  1,
  1,
  'dp_ht_business',
  '0.2.1',
  '1.0.0',
  '["system_health","database_summary"]',
  'HT_MCP_AUTH_TOKEN',
  'HT_BUSINESS_MCP',
  NULL,
  NULL,
  'Awaiting first authenticated health check',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO connector_instances (
  id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
  data_environment_id, last_sync_at, last_sync_status, last_sync_message,
  health_status, health_message, created_at, updated_at
) VALUES
  ('ci_ht_commusoft', 'co_ht', 'conn_commusoft', 'Commusoft', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_ht_sharepoint', 'co_ht', 'conn_sharepoint', 'SharePoint', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_ht_onedrive', 'co_ht', 'conn_onedrive', 'OneDrive', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_ht_xero', 'co_ht', 'conn_xero', 'Xero', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_ht_outlook', 'co_ht', 'conn_outlook_shared', 'Outlook Shared Mailbox', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO company_memberships
  (id, user_id, company_id, role, status, created_at, updated_at)
VALUES (
  'membership_ht_platform_admin',
  'user_f1df1e40-3d7b-49d1-aad2-d0fcab935f95',
  'co_ht',
  'company_admin',
  'active',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO audit_events
  (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
VALUES
  ('audit_ht_created', 'co_ht', 'company.created', 'infra-system', 'company', 'co_ht',
   '{"slug":"ht-business","openingCreditCents":1000,"testCredit":true}', datetime('now')),
  ('audit_ht_mcp', 'co_ht', 'mcp.registered', 'infra-system', 'mcp', 'mcp_ht_primary',
   '{"name":"HT Business MCP","endpoint":"https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp","authSecretRef":"HT_MCP_AUTH_TOKEN","serviceBindingRef":"HT_BUSINESS_MCP","isExternal":true}',
   datetime('now'));

-- EL Business
INSERT OR IGNORE INTO companies (
  id, slug, name, status, primary_domain, notes,
  trading_name, country, timezone,
  portal_subdomain, portal_hostname, provisioned_at,
  created_at, updated_at
) VALUES (
  'co_el',
  'el-business',
  'EL Business',
  'active',
  NULL,
  'Existing EL Business MCP attached. Knowledge not configured. Entity warehouse framework present, no operational records yet.',
  'EL Business',
  'GB',
  'Europe/London',
  'el',
  'el.infra-web.pages.dev',
  datetime('now'),
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO credit_balances
  (company_id, balance_cents, currency, low_balance_threshold_cents, updated_at)
VALUES ('co_el', 0, 'GBP', 500, datetime('now'));

INSERT OR IGNORE INTO company_commercial_settings (
  company_id, currency, target_gross_margin_percent, minimum_charge_cents,
  monthly_platform_fee_cents, included_credit_cents, low_balance_threshold_cents,
  auto_top_up_enabled, billing_status, pricing_plan, updated_at
) VALUES ('co_el', 'GBP', 60, 1, 0, 1000, 500, 0, 'active', 'standard', datetime('now'));

INSERT OR IGNORE INTO company_modules
  (id, company_id, module_key, status, config_json, created_at, updated_at)
VALUES
  ('mod_el_knowledge', 'co_el', 'knowledge', 'available', '{}', datetime('now'), datetime('now')),
  ('mod_el_chatgpt', 'co_el', 'chatgpt', 'available', '{}', datetime('now'), datetime('now')),
  ('mod_el_claude', 'co_el', 'claude', 'available', '{}', datetime('now'), datetime('now')),
  ('mod_el_whatsapp', 'co_el', 'whatsapp', 'available', '{}', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO ai_client_connections
  (id, company_id, client_type, display_name, status, gateway_path, setup_notes, created_at, updated_at)
VALUES
  ('ai_co_el_chatgpt', 'co_el', 'chatgpt', 'ChatGPT', 'ready_to_connect', '/api/gateway/v1/mcp',
   'Generate a service identity token, then configure ChatGPT to call the INFRA MCP facade with the Bearer token. Do not point ChatGPT at the company MCP directly.',
   datetime('now'), datetime('now')),
  ('ai_co_el_claude', 'co_el', 'claude', 'Claude', 'coming_soon', '/api/gateway/v1/mcp',
   'Claude connector is coming soon.', datetime('now'), datetime('now')),
  ('ai_co_el_whatsapp', 'co_el', 'whatsapp', 'WhatsApp', 'coming_soon', '/api/gateway/v1/mcp',
   'WhatsApp channel gateway is planned for a later phase.', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO ledger_entries (
  id, company_id, entry_type, amount_cents, currency, balance_after_cents,
  reference_type, reference_id, description, metadata_json, created_by, created_at
) VALUES (
  'ledger_el_opening_test',
  'co_el',
  'promotional_credit',
  1000,
  'GBP',
  1000,
  'provisioning',
  'opening_co_el',
  '£10.00 TEST CREDIT (internal/test) for EL Business',
  '{"provisioned":true,"testCredit":true,"label":"TEST CREDIT"}',
  'infra-system',
  datetime('now')
);

UPDATE credit_balances
SET balance_cents = (
  SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries WHERE company_id = 'co_el'
), updated_at = datetime('now')
WHERE company_id = 'co_el';

INSERT OR IGNORE INTO mcp_environments (
  id, company_id, name, description, endpoint_url, transport, status,
  enabled, is_external, data_plane_id, mcp_version, business_mcp_core_version,
  capabilities_json, auth_secret_ref, service_binding_ref,
  last_health_check_at, last_healthy_at, health_message,
  created_at, updated_at
) VALUES (
  'mcp_el_primary',
  'co_el',
  'EL Business MCP',
  'Existing EL Business MCP Worker. Knowledge not configured; no live business-system connectors.',
  'https://el-business-mcp.daniel-dwyer123.workers.dev/mcp',
  'streamable-http',
  'registered',
  1,
  1,
  'dp_el_business',
  '1.0.0',
  '1.0.0',
  '["system_health"]',
  'EL_MCP_AUTH_TOKEN',
  'EL_BUSINESS_MCP',
  NULL,
  NULL,
  'Awaiting first authenticated health check',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO connector_instances (
  id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
  data_environment_id, last_sync_at, last_sync_status, last_sync_message,
  health_status, health_message, created_at, updated_at
) VALUES
  ('ci_el_bigchange', 'co_el', 'conn_bigchange', 'BigChange', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_el_sharepoint', 'co_el', 'conn_sharepoint', 'SharePoint', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_el_onedrive', 'co_el', 'conn_onedrive', 'OneDrive', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_el_xero', 'co_el', 'conn_xero', 'Xero', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_el_outlook', 'co_el', 'conn_outlook_shared', 'Outlook Shared Mailbox', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now')),
  ('ci_el_freshdesk', 'co_el', 'conn_freshdesk', 'Freshdesk', 'draft',
   '{"note":"Registry only. Do not mark Connected until the company MCP integration is live."}',
   '{"enabled":false,"mode":"manual","schedule":null}',
   NULL, NULL, NULL, 'Not connected — planned', 'unknown', 'Not configured', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO company_memberships
  (id, user_id, company_id, role, status, created_at, updated_at)
VALUES (
  'membership_el_platform_admin',
  'user_f1df1e40-3d7b-49d1-aad2-d0fcab935f95',
  'co_el',
  'company_admin',
  'active',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO audit_events
  (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
VALUES
  ('audit_el_created', 'co_el', 'company.created', 'infra-system', 'company', 'co_el',
   '{"slug":"el-business","openingCreditCents":1000,"testCredit":true}', datetime('now')),
  ('audit_el_mcp', 'co_el', 'mcp.registered', 'infra-system', 'mcp', 'mcp_el_primary',
   '{"name":"EL Business MCP","endpoint":"https://el-business-mcp.daniel-dwyer123.workers.dev/mcp","authSecretRef":"EL_MCP_AUTH_TOKEN","serviceBindingRef":"EL_BUSINESS_MCP","isExternal":true}',
   datetime('now'));
