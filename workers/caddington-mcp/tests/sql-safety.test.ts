import { describe, expect, it } from "vitest";
import { validateReadOnlySql } from "../src/sql-safety";

describe("validateReadOnlySql", () => {
  it("allows knowledge_documents query", () => {
    const result = validateReadOnlySql(
      "SELECT id, title FROM knowledge_documents"
    );
    expect(result.ok).toBe(true);
  });

  it("rejects DELETE", () => {
    expect(validateReadOnlySql("DELETE FROM entity_records").ok).toBe(false);
  });
});
