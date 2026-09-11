-- Phase 2: Commusoft-shaped operational schema for Heat Tech dummy data

INSERT OR IGNORE INTO entity_registry (entity_type, description, source_systems) VALUES
  ('customer', 'Customer accounts', 'commusoft,dummy'),
  ('quote', 'Sales quotes and estimates', 'commusoft,dummy'),
  ('invoice', 'Customer invoices', 'commusoft,dummy'),
  ('payment', 'Invoice payments', 'commusoft,dummy'),
  ('call_out', 'Emergency call-out jobs', 'commusoft,dummy');

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'commusoft',
  name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'residential',
  postcode TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  import_batch_id INTEGER REFERENCES import_log (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_external
  ON customers (source_system, external_id);

CREATE TABLE IF NOT EXISTS engineers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'commusoft',
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  import_batch_id INTEGER REFERENCES import_log (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_engineers_external
  ON engineers (source_system, external_id);

CREATE TABLE IF NOT EXISTS job_types (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT OR IGNORE INTO job_types (code, label) VALUES
  ('service', 'Annual service'),
  ('installation', 'Installation'),
  ('call_out', 'Emergency call-out'),
  ('maintenance', 'Planned maintenance'),
  ('boiler_repair', 'Boiler repair'),
  ('gas_safety', 'Gas safety check');

CREATE TABLE IF NOT EXISTS job_statuses (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT OR IGNORE INTO job_statuses (code, label) VALUES
  ('booked', 'Booked'),
  ('in_progress', 'In progress'),
  ('completed', 'Completed'),
  ('cancelled', 'Cancelled'),
  ('on_hold', 'On hold');

CREATE TABLE IF NOT EXISTS quote_statuses (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT OR IGNORE INTO quote_statuses (code, label) VALUES
  ('draft', 'Draft'),
  ('sent', 'Sent'),
  ('accepted', 'Accepted'),
  ('rejected', 'Rejected'),
  ('expired', 'Expired');

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'commusoft',
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  engineer_id INTEGER REFERENCES engineers (id),
  job_type_code TEXT NOT NULL REFERENCES job_types (code),
  status_code TEXT NOT NULL REFERENCES job_statuses (code),
  scheduled_start TEXT,
  scheduled_end TEXT,
  actual_start TEXT,
  actual_end TEXT,
  completion_date TEXT,
  is_call_out INTEGER NOT NULL DEFAULT 0,
  customer_charge REAL NOT NULL DEFAULT 0,
  engineer_cost REAL NOT NULL DEFAULT 0,
  materials_cost REAL NOT NULL DEFAULT 0,
  gross_profit REAL NOT NULL DEFAULT 0,
  gross_margin_pct REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  import_batch_id INTEGER REFERENCES import_log (id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs (customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_engineer ON jobs (engineer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status_code);
CREATE INDEX IF NOT EXISTS idx_jobs_completion ON jobs (completion_date);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs (job_type_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_external
  ON jobs (source_system, external_id);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'commusoft',
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status_code TEXT NOT NULL REFERENCES quote_statuses (code),
  quote_value REAL NOT NULL DEFAULT 0,
  sent_date TEXT,
  converted INTEGER NOT NULL DEFAULT 0,
  converted_job_id INTEGER REFERENCES jobs (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  import_batch_id INTEGER REFERENCES import_log (id)
);

CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes (customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes (status_code);
CREATE INDEX IF NOT EXISTS idx_quotes_converted ON quotes (converted);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_external
  ON quotes (source_system, external_id);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'commusoft',
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  job_id INTEGER REFERENCES jobs (id),
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  import_batch_id INTEGER REFERENCES import_log (id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices (job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (invoice_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_external
  ON invoices (source_system, external_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'commusoft',
  invoice_id INTEGER NOT NULL REFERENCES invoices (id),
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  import_batch_id INTEGER REFERENCES import_log (id)
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (payment_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external
  ON payments (source_system, external_id);
