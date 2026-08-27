-- Sync Caddington ChatGPT service identity scopes with connected Xero (no token rotation).
-- Safe to re-run.

UPDATE service_identities
SET scopes_json = '["knowledge.search","knowledge.read","system.health","xero.organisation.read","xero.contacts.read","xero.contacts.search","xero.invoices.read","xero.invoices.search","xero.invoices.get","xero.payments.read","xero.accounts.read","xero.bank_transactions.read","xero.reports.pnl.read","xero.reports.balance_sheet.read","xero.reports.aged.read","xero.sales.summary","xero.top_customers","xero.top_suppliers","xero.list_tax_rates","xero.vat.capability","xero.health","xero.token_refresh","xero.action.plan","xero.action.read","xero.action.confirm","xero.action.execute","xero.action.cancel","xero.action.list"]',
    updated_at = datetime('now')
WHERE company_id = 'co_caddington'
  AND status = 'active';

INSERT OR IGNORE INTO mcp_tool_action_map
  (id, mcp_environment_id, tool_name, action, risk_class, created_at)
VALUES
  ('map_cad_xero_org', 'mcp_caddington_primary', 'xero_get_organisation', 'xero.organisation.read', 'low_risk', datetime('now')),
  ('map_cad_xero_contacts', 'mcp_caddington_primary', 'xero_list_contacts', 'xero.contacts.search', 'low_risk', datetime('now')),
  ('map_cad_xero_contact', 'mcp_caddington_primary', 'xero_get_contact', 'xero.contacts.read', 'low_risk', datetime('now')),
  ('map_cad_xero_search_inv', 'mcp_caddington_primary', 'xero_search_invoices', 'xero.invoices.search', 'low_risk', datetime('now')),
  ('map_cad_xero_get_inv', 'mcp_caddington_primary', 'xero_get_invoice', 'xero.invoices.get', 'low_risk', datetime('now')),
  ('map_cad_xero_overdue', 'mcp_caddington_primary', 'xero_list_overdue_invoices', 'xero.invoices.read', 'low_risk', datetime('now')),
  ('map_cad_xero_payments', 'mcp_caddington_primary', 'xero_list_payments', 'xero.payments.read', 'low_risk', datetime('now')),
  ('map_cad_xero_accounts', 'mcp_caddington_primary', 'xero_list_accounts', 'xero.accounts.read', 'low_risk', datetime('now')),
  ('map_cad_xero_bank', 'mcp_caddington_primary', 'xero_list_bank_transactions', 'xero.bank_transactions.read', 'low_risk', datetime('now')),
  ('map_cad_xero_pnl', 'mcp_caddington_primary', 'xero_profit_and_loss', 'xero.reports.pnl.read', 'low_risk', datetime('now')),
  ('map_cad_xero_bs', 'mcp_caddington_primary', 'xero_balance_sheet', 'xero.reports.balance_sheet.read', 'low_risk', datetime('now')),
  ('map_cad_xero_aged', 'mcp_caddington_primary', 'xero_aged_receivables', 'xero.reports.aged.read', 'low_risk', datetime('now')),
  ('map_cad_xero_sales', 'mcp_caddington_primary', 'xero_sales_summary', 'xero.sales.summary', 'low_risk', datetime('now')),
  ('map_cad_xero_top', 'mcp_caddington_primary', 'xero_top_customers', 'xero.top_customers', 'low_risk', datetime('now')),
  ('map_cad_xero_top_sup', 'mcp_caddington_primary', 'xero_top_suppliers', 'xero.top_suppliers', 'low_risk', datetime('now')),
  ('map_cad_xero_tax', 'mcp_caddington_primary', 'xero_list_tax_rates', 'xero.tax_rates.read', 'low_risk', datetime('now')),
  ('map_cad_xero_vat', 'mcp_caddington_primary', 'xero_vat_capability', 'xero.vat.capability', 'low_risk', datetime('now'));
