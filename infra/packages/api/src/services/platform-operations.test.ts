import { describe, expect, it } from "vitest";
import { detectStuckAutomationRuns, collectSecuritySignals } from "./platform-operations";

function mockDb(handlers: Array<(sql: string) => unknown | undefined>) {
  return {
    prepare(sql: string) {
      return {
        binds: [] as unknown[],
        bind(...values: unknown[]) {
          this.binds = values;
          return this;
        },
        async all() {
          for (const handler of handlers) {
            const value = handler(sql);
            if (value !== undefined) return value;
          }
          return { results: [] };
        },
        async first() {
          for (const handler of handlers) {
            const value = handler(sql);
            if (value !== undefined) {
              if (typeof value === "object" && value !== null && "count" in value) return value;
              return (value as { results?: unknown[] }).results?.[0] ?? value;
            }
          }
          return null;
        },
      };
    },
  } as unknown as D1Database;
}

describe("stuck automation detection", () => {
  it("returns runs stuck in running/queued beyond threshold", async () => {
    const db = mockDb([
      (sql) =>
        sql.includes("automation_runs")
          ? {
              results: [
                {
                  id: "run_1",
                  company_id: "co_caddington",
                  automation_id: "auto_1",
                  status: "running",
                  started_at: "2026-08-28T08:00:00.000Z",
                  created_at: "2026-08-28T08:00:00.000Z",
                },
              ],
            }
          : undefined,
    ]);

    const stuck = await detectStuckAutomationRuns(db);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.companyId).toBe("co_caddington");
  });
});

describe("security signals", () => {
  it("counts permission denials separately from login failures", async () => {
    const db = mockDb([
      (sql) =>
        sql.includes("permission.denied") && !sql.includes("cross_tenant") && !sql.includes("write")
          ? { count: 4 }
          : undefined,
      (sql) => (sql.includes("cross_tenant") ? { count: 0 } : undefined),
      (sql) => (sql.includes("auth.login_failed") ? { count: 12 } : undefined),
      (sql) =>
        sql.includes("permission.denied") && sql.includes("write") ? { count: 2 } : undefined,
    ]);

    const signals = await collectSecuritySignals(db);
    expect(signals.permissionDenialsLast24h).toBe(4);
    expect(signals.failedAdminLoginsLast24h).toBe(12);
    expect(signals.financialWriteDenialsLast24h).toBe(2);
  });
});
