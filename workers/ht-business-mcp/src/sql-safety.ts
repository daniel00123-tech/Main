import { QUERYABLE_TABLES } from "./constants";

const BLOCKED_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|REINDEX|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|GRANT|REVOKE|EXEC|EXECUTE|CALL|LOAD|COPY|MERGE|UPSERT)\b/i;

const MULTI_STATEMENT_PATTERN = /;[\s\S]*\S/;

export interface SqlValidationResult {
  ok: true;
  normalizedSql: string;
}

export interface SqlValidationError {
  ok: false;
  error: string;
}

export type SqlValidation = SqlValidationResult | SqlValidationError;

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

export function validateReadOnlySql(sql: string): SqlValidation {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { ok: false, error: "Query must not be empty." };
  }

  const withoutComments = stripComments(trimmed);
  if (MULTI_STATEMENT_PATTERN.test(withoutComments)) {
    return { ok: false, error: "Only a single SQL statement is allowed." };
  }

  if (BLOCKED_PATTERN.test(withoutComments)) {
    return {
      ok: false,
      error: "Only read-only SELECT queries are permitted.",
    };
  }

  const normalized = withoutComments.trim().replace(/\s+/g, " ");
  const upper = normalized.toUpperCase();

  if (!upper.startsWith("SELECT")) {
    return { ok: false, error: "Query must begin with SELECT." };
  }

  const tableRefs = extractTableReferences(normalized);
  for (const table of tableRefs) {
    if (!QUERYABLE_TABLES.has(table.toLowerCase())) {
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
  const fromJoin =
    /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = fromJoin.exec(sql)) !== null) {
    tables.push(match[1]);
  }
  return tables;
}
