import { log } from "./logger";

export interface Env {
  HT_BUSINESS_DATA: D1Database;
  MCP_AUTH_TOKEN?: string;
}

export interface DbHealth {
  connected: boolean;
  latencyMs?: number;
  error?: string;
}

export async function checkDatabaseHealth(db: D1Database): Promise<DbHealth> {
  const start = Date.now();
  try {
    await db.prepare("SELECT 1 AS ok").first();
    return { connected: true, latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "database_health_check_failed", { error: message });
    return { connected: false, error: message };
  }
}

export interface TableSummary {
  name: string;
  recordCount: number;
  latestTimestamp: string | null;
}

const TABLE_TIMESTAMP_COLUMNS: Record<string, string> = {
  import_log: "started_at",
  entity_registry: "updated_at",
  entity_records: "updated_at",
};

export async function getDatabaseSummary(db: D1Database): Promise<TableSummary[]> {
  const tables = ["import_log", "entity_registry", "entity_records"];
  const summaries: TableSummary[] = [];

  for (const name of tables) {
    const countRow = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${name}`)
      .first<{ count: number }>();
    const recordCount = countRow?.count ?? 0;

    const tsColumn = TABLE_TIMESTAMP_COLUMNS[name];
    let latestTimestamp: string | null = null;
    if (tsColumn) {
      const tsRow = await db
        .prepare(`SELECT MAX(${tsColumn}) AS latest FROM ${name}`)
        .first<{ latest: string | null }>();
      latestTimestamp = tsRow?.latest ?? null;
    }

    summaries.push({ name, recordCount, latestTimestamp });
  }

  return summaries;
}

export async function runReadOnlyQuery(
  db: D1Database,
  sql: string
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number }> {
  const result = await db.prepare(sql).all();
  const columns = result.results.length > 0
    ? Object.keys(result.results[0] as Record<string, unknown>)
    : [];
  return {
    columns,
    rows: result.results as Record<string, unknown>[],
    rowCount: result.results.length,
  };
}
