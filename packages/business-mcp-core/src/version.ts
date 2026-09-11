/** Business MCP Core semantic version — independent from company MCP versions. */
export const CORE_VERSION = "1.0.0";

export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

export const SEARCH_VECTOR_CANDIDATE_MIN = 30;
export const SEARCH_VECTOR_CANDIDATE_MAX = 50;
export const SEARCH_LEXICAL_CANDIDATE_MAX = 50;
export const SEARCH_DOCUMENT_CANDIDATE_MAX = 30;
export const SEARCH_RERANK_POOL_MAX = 40;
export const SEARCH_DEFAULT_TOP_K = 8;
export const SEARCH_MAX_TOP_K = 12;

export const DEFAULT_CHUNK_SIZE = 900;
export const DEFAULT_CHUNK_OVERLAP = 120;

/** Generic R2 health probe object key — not company-specific. */
export const R2_HEALTH_PROBE_KEY = ".__business_mcp_health_probe";

/** Hourly UTC cron pattern used with in-handler timezone gating. */
export const HOURLY_UTC_CRON_EXPRESSION = "0 * * * *";
