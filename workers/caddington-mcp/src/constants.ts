export const MCP_VERSION = "1.0.0";
export const MCP_NAME = "caddington-mcp";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;

export const SEARCH_VECTOR_CANDIDATE_MIN = 30;
export const SEARCH_VECTOR_CANDIDATE_MAX = 50;
export const SEARCH_LEXICAL_CANDIDATE_MAX = 50;
export const SEARCH_DOCUMENT_CANDIDATE_MAX = 30;
export const SEARCH_RERANK_POOL_MAX = 40;
export const SEARCH_DEFAULT_TOP_K = 8;
export const SEARCH_MAX_TOP_K = 12;

/** Read-only tables for query_business_data */
export const QUERYABLE_TABLES = new Set([
  "import_log",
  "system_health_log",
  "connector_registry",
  "entity_registry",
  "entity_records",
  "knowledge_documents",
  "knowledge_chunks",
  "knowledge_import_log",
  "connector_config",
  "google_drive_files",
]);

export const SUMMARY_TABLES = [
  "import_log",
  "system_health_log",
  "connector_registry",
  "entity_registry",
  "entity_records",
  "knowledge_documents",
  "knowledge_chunks",
  "knowledge_import_log",
  "connector_config",
  "google_drive_files",
] as const;

export const SUMMARY_TIMESTAMP_COLUMNS: Record<string, string> = {
  import_log: "started_at",
  system_health_log: "checked_at",
  connector_registry: "updated_at",
  entity_registry: "updated_at",
  entity_records: "updated_at",
  knowledge_documents: "updated_at",
  knowledge_chunks: "created_at",
  knowledge_import_log: "started_at",
  connector_config: "updated_at",
  google_drive_files: "last_synced_at",
};
