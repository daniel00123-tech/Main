-- Seed TEST 1p pricing for Xero Action Engine write operations.
-- INSERT OR IGNORE ensures idempotent application on deploy.

INSERT OR IGNORE INTO pricing_rules (
  id, company_id, action, pricing_mode, fixed_charge_cents, markup_percent,
  minimum_charge_cents, charge_on_failure, is_billable, label, is_test_config,
  enabled, created_at, updated_at, target_margin_bps, version_label, effective_from
) VALUES
  ('price_xero_invoice_create', NULL, 'xero.invoices.create', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.invoices.create = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_invoice_update', NULL, 'xero.invoices.update', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.invoices.update = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_invoice_approve', NULL, 'xero.invoices.approve', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.invoices.approve = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_invoice_send', NULL, 'xero.invoices.send', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.invoices.send = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_bill_create', NULL, 'xero.bills.create', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.bills.create = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_bill_approve', NULL, 'xero.bills.approve', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.bills.approve = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_credit_note_create', NULL, 'xero.credit_notes.create_draft', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.credit_notes.create_draft = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_credit_note_approve', NULL, 'xero.credit_notes.approve', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.credit_notes.approve = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_credit_note_allocate', NULL, 'xero.credit_notes.allocate', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.credit_notes.allocate = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_payment_allocate', NULL, 'xero.payments.allocate', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.payments.allocate = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_contact_create', NULL, 'xero.contacts.create', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.contacts.create = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now')),
  ('price_xero_invoice_void', NULL, 'xero.invoice.void', 'fixed', 1, NULL, 1, 0, 1, 'TEST: xero.invoice.void = 1p', 1, 1, datetime('now'), datetime('now'), 6000, 'v1', datetime('now'));
