import { describe, expect, it } from "vitest";
import { recordUsageEvent } from "./usage";

type Row = Record<string, unknown>;

function mockDb(rows: Row[]) {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          const q = sql.toLowerCase();
          if (q.includes("where request_id")) {
            return rows.find((row) => row.request_id === values[0]) ?? null;
          }
          if (q.includes("where correlation_id")) {
            return rows.find((row) => row.correlation_id === values[0]) ?? null;
          }
          return null;
        },
        run: async () => {
          if (sql.toLowerCase().includes("insert into usage_records")) {
            rows.push({
              id: values[0],
              company_id: values[1],
              request_id: values[21],
              correlation_id: values[18],
              source_client: values[17],
              user_id: values[8],
              settlement_status: values[33],
            });
          }
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
}

describe("usage event idempotency", () => {
  it("returns the existing row for a repeated request id", async () => {
    const rows: Row[] = [];
    const db = mockDb(rows);
    const first = await recordUsageEvent(db, {
      companyId: "co_el",
      userId: "user_william",
      resourceType: "gateway",
      toolName: "search",
      sourceClient: "chatgpt",
      requestId: "req_same",
      correlationId: "corr_1",
      success: true,
    });
    const second = await recordUsageEvent(db, {
      companyId: "co_el",
      userId: "user_william",
      resourceType: "gateway",
      toolName: "search",
      sourceClient: "chatgpt",
      requestId: "req_same",
      correlationId: "corr_2",
      success: true,
    });
    expect(first.alreadyExists).toBe(false);
    expect(second.alreadyExists).toBe(true);
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
  });
});
