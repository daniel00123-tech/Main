import {
  validateReadOnlySql as validateReadOnlySqlCore,
  type SqlValidation,
} from "@business-mcp/core";
import { QUERYABLE_TABLES } from "./constants";

export type { SqlValidation };

export function validateReadOnlySql(sql: string): SqlValidation {
  return validateReadOnlySqlCore(sql, QUERYABLE_TABLES);
}
