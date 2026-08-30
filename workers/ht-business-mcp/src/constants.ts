export const MCP_VERSION = "0.1.0";
export const MCP_NAME = "ht-business-mcp";

/** Tables exposed to read-only query_business_data tool */
export const QUERYABLE_TABLES = new Set([
  "import_log",
  "entity_registry",
  "entity_records",
  "customers",
  "engineers",
  "job_types",
  "job_statuses",
  "quote_statuses",
  "jobs",
  "quotes",
  "invoices",
  "payments",
]);

/** Operational tables included in database_summary */
export const SUMMARY_TABLES = [
  "import_log",
  "entity_registry",
  "entity_records",
  "customers",
  "engineers",
  "jobs",
  "quotes",
  "invoices",
  "payments",
  "job_types",
  "job_statuses",
  "quote_statuses",
] as const;

export const SUMMARY_TIMESTAMP_COLUMNS: Record<string, string> = {
  import_log: "started_at",
  entity_registry: "updated_at",
  entity_records: "updated_at",
  customers: "updated_at",
  engineers: "updated_at",
  jobs: "updated_at",
  quotes: "updated_at",
  invoices: "invoice_date",
  payments: "payment_date",
  job_types: "code",
  job_statuses: "code",
  quote_statuses: "code",
};
