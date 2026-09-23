import { describe, expect, it } from "vitest";
import { validateReadOnlySql } from "../src/sql-safety";

describe("validateReadOnlySql", () => {
  it("accepts simple SELECT", () => {
    const result = validateReadOnlySql("SELECT * FROM entity_records");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedSql).toBe("SELECT * FROM entity_records");
    }
  });

  it("rejects INSERT", () => {
    const result = validateReadOnlySql(
      "INSERT INTO entity_records (data) VALUES ('{}')"
    );
    expect(result.ok).toBe(false);
  });

  it("rejects DELETE", () => {
    const result = validateReadOnlySql("DELETE FROM entity_records");
    expect(result.ok).toBe(false);
  });

  it("rejects UPDATE", () => {
    const result = validateReadOnlySql(
      "UPDATE entity_records SET data = '{}'"
    );
    expect(result.ok).toBe(false);
  });

  it("rejects DROP", () => {
    const result = validateReadOnlySql("DROP TABLE entity_records");
    expect(result.ok).toBe(false);
  });

  it("rejects multi-statement queries", () => {
    const result = validateReadOnlySql(
      "SELECT 1; SELECT * FROM entity_records"
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unknown tables", () => {
    const result = validateReadOnlySql("SELECT * FROM secrets");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("secrets");
    }
  });

  it("allows JOIN across allowed tables", () => {
    const result = validateReadOnlySql(
      "SELECT e.id FROM entity_records e JOIN import_log i ON e.import_batch_id = i.id"
    );
    expect(result.ok).toBe(true);
  });

  it("strips comments before validation", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM entity_records -- harmless comment"
    );
    expect(result.ok).toBe(true);
  });

  it("ignores destructive keywords inside block comments", () => {
    const result = validateReadOnlySql(
      "SELECT 1 /* DELETE FROM entity_records */"
    );
    expect(result.ok).toBe(true);
  });
});
