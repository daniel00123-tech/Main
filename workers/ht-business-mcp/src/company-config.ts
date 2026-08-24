import { CORE_VERSION } from "@business-mcp/core";
import type { CompanyIdentity, McpVersionInfo } from "@business-mcp/core";
import {
  COMPANY_NAME,
  ENVIRONMENT,
  MCP_NAME,
  MCP_VERSION,
  QUERYABLE_TABLES,
  SUMMARY_TABLES,
  SUMMARY_TIMESTAMP_COLUMNS,
} from "./constants";

export const HT_IDENTITY: CompanyIdentity = {
  company: COMPANY_NAME,
  companySlug: "ht-business",
  environment: ENVIRONMENT,
  serviceName: MCP_NAME,
};

export const HT_VERSIONS: McpVersionInfo = {
  mcpVersion: MCP_VERSION,
  coreVersion: CORE_VERSION,
};

export const HT_STRUCTURED_DATA_CONFIG = {
  queryableTables: QUERYABLE_TABLES,
  summary: {
    tables: SUMMARY_TABLES,
    timestampColumns: SUMMARY_TIMESTAMP_COLUMNS,
  },
};

export const HT_KNOWLEDGE_CONFIGURED = false;
