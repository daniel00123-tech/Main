export const MCP_VERSION = "1.2.0";
export const MCP_NAME = "el-business-mcp";

export const COMPANY_NAME = "EL Business";
export const COMPANY_SLUG = "el-business";
export const ENVIRONMENT = "production";

export const QUERYABLE_TABLES = new Set([
  "import_log",
  "system_health_log",
  "connector_registry",
  "connector_config",
  "entity_registry",
  "entity_records",
  "microsoft_index_items",
  "microsoft_sync_state",
]);

export const SUMMARY_TABLES = [
  "import_log",
  "system_health_log",
  "connector_registry",
  "connector_config",
  "entity_registry",
  "entity_records",
  "microsoft_index_items",
  "microsoft_sync_state",
  "xero_connections",
] as const;

export const SUMMARY_TIMESTAMP_COLUMNS: Record<string, string | null> = {
  import_log: "started_at",
  system_health_log: "checked_at",
  connector_registry: "updated_at",
  connector_config: "updated_at",
  entity_registry: "updated_at",
  entity_records: "updated_at",
  microsoft_index_items: "updated_at",
  microsoft_sync_state: "updated_at",
  xero_connections: "updated_at",
};
