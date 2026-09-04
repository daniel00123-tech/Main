-- INFRA Business Data Warehouse V1
-- Tenant-aware structured warehouse. EL Xero is the first adapter.
-- Every fact row is company-scoped. No cross-tenant keys.

CREATE TABLE IF NOT EXISTS warehouse_sources (
  company_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEVER_SYNCED',
  last_successful_sync TEXT,
  last_attempted_sync TEXT,
  warehouse_last_updated_at TEXT,
  source_last_updated_at TEXT,
  sync_status TEXT,
  checkpoint_json TEXT,
  historical_from TEXT,
  historical_to TEXT,
  last_reconciliation_json TEXT,
  last_failure_code TEXT,
  record_counts_json TEXT,
  lock_owner TEXT,
  lock_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, connector)
);

CREATE TABLE IF NOT EXISTS warehouse_sync_runs (
  sync_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  checkpoint_before TEXT,
  checkpoint_after TEXT,
  records_read INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  snapshots_written INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  failure_code TEXT,
  latency_ms INTEGER,
  reconciliation_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_warehouse_sync_runs_company
  ON warehouse_sync_runs (company_id, connector, started_at);

CREATE TABLE IF NOT EXISTS warehouse_xero_invoices (
  company_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  invoice_number TEXT,
  type TEXT,
  contact_id TEXT,
  contact_name TEXT,
  status TEXT,
  invoice_date TEXT,
  due_date TEXT,
  reference TEXT,
  currency TEXT,
  subtotal REAL,
  tax REAL,
  total REAL,
  amount_due REAL,
  amount_paid REAL,
  amount_credited REAL,
  source_updated_at TEXT,
  warehouse_updated_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_xero_invoices_date
  ON warehouse_xero_invoices (company_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_warehouse_xero_invoices_status
  ON warehouse_xero_invoices (company_id, status, is_current);

CREATE TABLE IF NOT EXISTS warehouse_xero_invoice_lines (
  company_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  description TEXT,
  quantity REAL,
  unit_amount REAL,
  tax REAL,
  line_total REAL,
  account_code TEXT,
  warehouse_updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, invoice_id, line_id)
);

CREATE TABLE IF NOT EXISTS warehouse_xero_contacts (
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT,
  is_customer INTEGER,
  is_supplier INTEGER,
  account_number TEXT,
  source_updated_at TEXT,
  warehouse_updated_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, contact_id)
);

CREATE TABLE IF NOT EXISTS warehouse_xero_payments (
  company_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  invoice_id TEXT,
  payment_date TEXT,
  amount REAL,
  status TEXT,
  payment_type TEXT,
  reference TEXT,
  source_updated_at TEXT,
  warehouse_updated_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_xero_payments_date
  ON warehouse_xero_payments (company_id, payment_date);

CREATE TABLE IF NOT EXISTS warehouse_xero_credit_notes (
  company_id TEXT NOT NULL,
  credit_note_id TEXT NOT NULL,
  credit_note_number TEXT,
  type TEXT,
  contact_id TEXT,
  contact_name TEXT,
  status TEXT,
  credit_date TEXT,
  reference TEXT,
  currency TEXT,
  subtotal REAL,
  tax REAL,
  total REAL,
  remaining_credit REAL,
  source_updated_at TEXT,
  warehouse_updated_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, credit_note_id)
);

CREATE TABLE IF NOT EXISTS warehouse_snapshots (
  company_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  as_of TEXT NOT NULL,
  sync_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (company_id, connector, snapshot_type, as_of)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_snapshots_type
  ON warehouse_snapshots (company_id, connector, snapshot_type, as_of);

CREATE TABLE IF NOT EXISTS warehouse_kpi_snapshots (
  company_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  as_of TEXT NOT NULL,
  sync_id TEXT,
  sales_mtd REAL,
  sales_today REAL,
  invoice_count_mtd INTEGER,
  outstanding_receivables REAL,
  overdue_receivables REAL,
  overdue_invoice_count INTEGER,
  paid_amount_mtd REAL,
  top_customers_json TEXT,
  currency TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (company_id, connector, as_of)
);
