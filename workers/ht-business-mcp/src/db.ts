import {
  checkDatabaseHealth as checkDatabaseHealthCore,
  createLogger,
  getDatabaseSummary as getDatabaseSummaryCore,
  runReadOnlyQuery as runReadOnlyQueryCore,
  type DbHealth,
} from "@business-mcp/core";
import { HT_STRUCTURED_DATA_CONFIG } from "./company-config";
import { MCP_NAME } from "./constants";

const htLogger = createLogger(MCP_NAME);

export interface Env {
  HT_BUSINESS_DATA: D1Database;
  MCP_AUTH_TOKEN?: string;
}

export type { DbHealth };

export interface TableSummary {
  name: string;
  recordCount: number;
  latestTimestamp: string | null;
}

export async function checkDatabaseHealth(db: D1Database): Promise<DbHealth> {
  return checkDatabaseHealthCore(db, htLogger);
}

export async function getDatabaseSummary(db: D1Database): Promise<TableSummary[]> {
  return getDatabaseSummaryCore(db, HT_STRUCTURED_DATA_CONFIG.summary);
}

export async function runReadOnlyQuery(
  db: D1Database,
  sql: string
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number }> {
  return runReadOnlyQueryCore(db, sql);
}
