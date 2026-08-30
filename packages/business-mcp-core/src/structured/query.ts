import type { DatabaseSummaryTable, SummaryTableConfig } from "../types/company-config";

export async function runReadOnlyQuery(
  db: D1Database,
  sql: string
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}> {
  const result = await db.prepare(sql).all();
  const columns =
    result.results.length > 0
      ? Object.keys(result.results[0] as Record<string, unknown>)
      : [];
  return {
    columns,
    rows: result.results as Record<string, unknown>[],
    rowCount: result.results.length,
  };
}

export async function getDatabaseSummary(
  db: D1Database,
  config: SummaryTableConfig
): Promise<DatabaseSummaryTable[]> {
  const summaries: DatabaseSummaryTable[] = [];

  for (const name of config.tables) {
    const countRow = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${name}`)
      .first<{ count: number }>();
    const recordCount = countRow?.count ?? 0;

    const tsColumn = config.timestampColumns[name];
    let latestTimestamp: string | null = null;
    if (tsColumn && tsColumn !== "code") {
      const tsRow = await db
        .prepare(`SELECT MAX(${tsColumn}) AS latest FROM ${name}`)
        .first<{ latest: string | null }>();
      latestTimestamp = tsRow?.latest ?? null;
    }

    summaries.push({ name, recordCount, latestTimestamp });
  }

  return summaries;
}

export async function countKnowledgeDocuments(
  db: D1Database
): Promise<{ total: number; indexed: number; lastIndexedAt: string | null }> {
  try {
    const totalRow = await db
      .prepare("SELECT COUNT(*) AS count FROM knowledge_documents")
      .first<{ count: number }>();
    const indexedRow = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM knowledge_documents WHERE status = 'indexed'"
      )
      .first<{ count: number }>();
    const latestRow = await db
      .prepare(
        "SELECT MAX(indexed_at) AS latest FROM knowledge_documents WHERE status = 'indexed'"
      )
      .first<{ latest: string | null }>();

    return {
      total: totalRow?.count ?? 0,
      indexed: indexedRow?.count ?? 0,
      lastIndexedAt: latestRow?.latest ?? null,
    };
  } catch {
    return { total: 0, indexed: 0, lastIndexedAt: null };
  }
}
