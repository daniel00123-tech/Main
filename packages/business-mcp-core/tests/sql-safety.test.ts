import { describe, expect, it } from "vitest";
import {
  validateReadOnlySql,
  appendLimitIfMissing,
} from "../src/structured/sql-safety";

const WAREHOUSE_TABLES = new Set([
  "import_log",
  "entity_registry",
  "entity_records",
  "knowledge_documents",
  "knowledge_chunks",
]);

describe("validateReadOnlySql", () => {
  it("accepts simple SELECT", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM entity_records",
      WAREHOUSE_TABLES
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedSql).toBe("SELECT * FROM entity_records");
    }
  });

  it("allows knowledge_documents query", () => {
    const result = validateReadOnlySql(
      "SELECT id, title FROM knowledge_documents",
      WAREHOUSE_TABLES
    );
    expect(result.ok).toBe(true);
  });

  it("rejects INSERT", () => {
    expect(
      validateReadOnlySql(
        "INSERT INTO entity_records (data) VALUES ('{}')",
        WAREHOUSE_TABLES
      ).ok
    ).toBe(false);
  });

  it("rejects DELETE", () => {
    expect(
      validateReadOnlySql("DELETE FROM entity_records", WAREHOUSE_TABLES).ok
    ).toBe(false);
  });

  it("rejects UPDATE", () => {
    expect(
      validateReadOnlySql(
        "UPDATE entity_records SET data = '{}'",
        WAREHOUSE_TABLES
      ).ok
    ).toBe(false);
  });

  it("rejects DROP", () => {
    expect(
      validateReadOnlySql("DROP TABLE entity_records", WAREHOUSE_TABLES).ok
    ).toBe(false);
  });

  it("rejects multi-statement queries", () => {
    expect(
      validateReadOnlySql(
        "SELECT 1; SELECT * FROM entity_records",
        WAREHOUSE_TABLES
      ).ok
    ).toBe(false);
  });

  it("rejects unknown tables", () => {
    const result = validateReadOnlySql("SELECT * FROM secrets", WAREHOUSE_TABLES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("secrets");
    }
  });

  it("allows JOIN across allowed tables", () => {
    expect(
      validateReadOnlySql(
        "SELECT e.id FROM entity_records e JOIN import_log i ON e.import_batch_id = i.id",
        WAREHOUSE_TABLES
      ).ok
    ).toBe(true);
  });

  it("strips comments before validation", () => {
    expect(
      validateReadOnlySql(
        "SELECT * FROM entity_records -- harmless comment",
        WAREHOUSE_TABLES
      ).ok
    ).toBe(true);
  });

  it("ignores destructive keywords inside block comments", () => {
    expect(
      validateReadOnlySql(
        "SELECT 1 /* DELETE FROM entity_records */",
        WAREHOUSE_TABLES
      ).ok
    ).toBe(true);
  });
});

describe("appendLimitIfMissing", () => {
  it("appends LIMIT when missing", () => {
    expect(appendLimitIfMissing("SELECT 1", 100)).toBe("SELECT 1 LIMIT 100");
  });

  it("preserves existing LIMIT", () => {
    expect(appendLimitIfMissing("SELECT 1 LIMIT 5", 100)).toBe(
      "SELECT 1 LIMIT 5"
    );
  });
});
