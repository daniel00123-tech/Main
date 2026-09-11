import { CORE_VERSION } from "@business-mcp/core";
import type { CompanyIdentity, McpVersionInfo } from "@business-mcp/core";
import {
  COMPANY_NAME,
  COMPANY_SLUG,
  ENVIRONMENT,
  MCP_NAME,
  MCP_VERSION,
  QUERYABLE_TABLES,
  SUMMARY_TABLES,
  SUMMARY_TIMESTAMP_COLUMNS,
} from "./constants";

export const EL_IDENTITY: CompanyIdentity = {
  company: COMPANY_NAME,
  companySlug: COMPANY_SLUG,
  environment: ENVIRONMENT,
  serviceName: MCP_NAME,
};

export const EL_VERSIONS: McpVersionInfo = {
  mcpVersion: MCP_VERSION,
  coreVersion: CORE_VERSION,
};

export const EL_STRUCTURED_DATA_CONFIG = {
  queryableTables: QUERYABLE_TABLES,
  summary: {
    tables: SUMMARY_TABLES,
    timestampColumns: SUMMARY_TIMESTAMP_COLUMNS,
  },
};

/** Knowledge bindings are not provisioned in Phase 3. */
export const EL_KNOWLEDGE_CONFIGURED = false;
