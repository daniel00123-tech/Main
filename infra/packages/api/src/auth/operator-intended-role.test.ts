import { describe, expect, it } from "vitest";
import {
  persistOperatorIntendedRole,
  readOperatorIntendedRole,
  restoreOperatorIntendedRole,
} from "./operator-intended-role";

type Row = Record<string, unknown>;

function memoryDb() {
  const tables = {
    membership_operator_roles: [] as Row[],
    company_memberships: [
      {
        id: "membership_78495c59-cff6-4db5-9986-a351ebe154f1",
        user_id: "user_b0db1fc5-692c-436d-99e6-392966b20df8",
        company_id: "co_el",
        role: "office_staff",
        updated_at: "before",
      },
    ],
  };
  const api = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (sql.includes("CREATE TABLE")) return { success: true };
              if (sql.includes("INSERT OR REPLACE INTO membership_operator_roles")) {
                tables.membership_operator_roles = [
                  {
                    membership_id: values[0],
                    company_id: values[1],
                    user_id: values[2],
                    intended_role: values[3],
                    set_by: values[4],
                    set_at: values[5],
                  },
                ];
              }
              if (sql.includes("UPDATE company_memberships")) {
                const row = tables.company_memberships[0];
                if (row) {
                  row.role = values[0];
                  row.updated_at = values[1];
                }
              }
              return { success: true };
            },
            async first() {
              if (sql.includes("FROM membership_operator_roles")) {
                return tables.membership_operator_roles[0] ?? null;
              }
              return tables.company_memberships[0] ?? null;
            },
          };
        },
        async run() {
          return { success: true };
        },
        async all() {
          return { results: tables.membership_operator_roles };
        },
        async first() {
          return tables.company_memberships[0] ?? null;
        },
      };
    },
  };
  return { db: api as unknown as D1Database, tables };
}

describe("operator intended membership role", () => {
  it("persists portal Director separately from a temporary office_staff probe role", async () => {
    const { db, tables } = memoryDb();
    await persistOperatorIntendedRole(db, {
      membershipId: "membership_78495c59-cff6-4db5-9986-a351ebe154f1",
      companyId: "co_el",
      userId: "user_b0db1fc5-692c-436d-99e6-392966b20df8",
      intendedRole: "director",
      setBy: "daniel.dwyer123@gmail.com",
    });
    expect(await readOperatorIntendedRole(db, "membership_78495c59-cff6-4db5-9986-a351ebe154f1")).toBe(
      "director",
    );
    expect(tables.company_memberships[0]?.role).toBe("office_staff");
    const restored = await restoreOperatorIntendedRole(db, {
      membershipId: "membership_78495c59-cff6-4db5-9986-a351ebe154f1",
      userId: "user_b0db1fc5-692c-436d-99e6-392966b20df8",
      companyId: "co_el",
      fallback: "director",
    });
    expect(restored).toBe("director");
    expect(tables.company_memberships[0]?.role).toBe("director");
  });

  it("enforces intended Director after a stale office_staff overwrite", async () => {
    const { db, tables } = memoryDb();
    tables.membership_operator_roles.push({
      membership_id: "membership_78495c59-cff6-4db5-9986-a351ebe154f1",
      company_id: "co_el",
      user_id: "user_b0db1fc5-692c-436d-99e6-392966b20df8",
      intended_role: "director",
    });
    tables.company_memberships[0]!.updated_at = "2000-01-01 00:00:00";
    const { enforceOperatorIntendedRoles } = await import("./operator-intended-role");
    const restored = await enforceOperatorIntendedRoles(db);
    expect(restored).toBe(1);
    expect(tables.company_memberships[0]?.role).toBe("director");
  });
});
