export interface CompanyIdentity {
  company: string;
  companySlug: string;
  environment: string;
  serviceName: string;
}

export interface McpVersionInfo {
  mcpVersion: string;
  coreVersion: string;
}

export interface SummaryTableConfig {
  tables: readonly string[];
  timestampColumns: Record<string, string | null>;
}

export interface StructuredDataConfig {
  queryableTables: ReadonlySet<string>;
  summary: SummaryTableConfig;
}

export interface KnowledgeBindings {
  configured: boolean;
  r2?: R2Bucket;
  vectorIndex?: VectorizeIndex;
  ai?: Ai;
}

export interface CompanyMcpConfig {
  identity: CompanyIdentity;
  versions: McpVersionInfo;
  structuredData: StructuredDataConfig;
  knowledge?: KnowledgeBindings;
  requireMcpAuth: boolean;
  requireAdminAuth: boolean;
}

export interface DatabaseSummaryTable {
  name: string;
  recordCount: number;
  latestTimestamp: string | null;
}
