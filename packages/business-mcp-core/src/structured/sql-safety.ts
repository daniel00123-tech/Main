const BLOCKED_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|REINDEX|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|GRANT|REVOKE|EXEC|EXECUTE|CALL|LOAD|COPY|MERGE|UPSERT)\b/i;

const MULTI_STATEMENT_PATTERN = /;[\s\S]*\S/;

export type SqlValidation =
  | { ok: true; normalizedSql: string }
  | { ok: false; error: string };

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

export function validateReadOnlySql(
  sql: string,
  allowedTables: ReadonlySet<string>
): SqlValidation {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: "Query must not be empty." };

  const withoutComments = stripComments(trimmed);
  if (MULTI_STATEMENT_PATTERN.test(withoutComments)) {
    return { ok: false, error: "Only a single SQL statement is allowed." };
  }
  if (BLOCKED_PATTERN.test(withoutComments)) {
    return { ok: false, error: "Only read-only SELECT queries are permitted." };
  }

  const normalized = withoutComments.trim().replace(/\s+/g, " ");
  if (!normalized.toUpperCase().startsWith("SELECT")) {
    return { ok: false, error: "Query must begin with SELECT." };
  }

  for (const table of extractTableReferences(normalized)) {
    if (!allowedTables.has(table.toLowerCase())) {
      return {
        ok: false,
        error: `Table "${table}" is not available for querying.`,
      };
    }
  }

  return { ok: true, normalizedSql: normalized };
}

function extractTableReferences(sql: string): string[] {
  const tables: string[] = [];
  const re = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    tables.push(match[1]);
  }
  return tables;
}

export function appendLimitIfMissing(sql: string, limit: number): string {
  if (/\blimit\b/i.test(sql)) {
    return sql;
  }
  return `${sql} LIMIT ${limit}`;
}
