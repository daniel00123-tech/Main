import { describe, expect, it } from "vitest";
import {
  defaultIngestionPolicyForCompany,
  ensureCompanyIngestionPolicy,
  matchesElvexExcludedPerson,
  resolveMailboxIngestionPolicy,
  seedElvexIngestionExclusions,
  upsertIngestionOverride,
} from "./mailbox-ingestion-policy";

type Row = Record<string, unknown>;

function memoryDb() {
  const policies: Row[] = [];
  const overrides: Row[] = [];
  const users: Row[] = [
    { id: "user_william", email: "william@elvexpropertyservices.com", display_name: "William" },
    { id: "user_ella", email: "ella@elvexpropertyservices.com", display_name: "Ella Mae" },
    { id: "user_lauren", email: "lauren@elvexpropertyservices.com", display_name: "Lauren" },
  ];
  const memberships: Row[] = users.map((user) => ({
    user_id: user.id,
    company_id: "co_el",
    status: "active",
  }));

  const exec = (sql: string, binds: unknown[]) => ({
    run: async () => {
      if (sql.includes("CREATE TABLE")) return { success: true };
      if (sql.includes("INSERT OR IGNORE INTO company_mailbox_ingestion_policies")) {
        if (!policies.some((row) => row.company_id === binds[0])) {
          policies.push({ company_id: binds[0], default_policy: binds[1], updated_at: binds[2] });
        }
      }
      if (sql.includes("INSERT INTO company_mailbox_ingestion_overrides")) {
        overrides.push({
          id: binds[0],
          company_id: binds[1],
          mailbox_id: binds[2],
          mailbox_address: binds[3],
          display_name: binds[4],
          policy: binds[5],
          reason: binds[6],
          updated_at: binds[7],
          created_at: binds[8],
        });
      }
      if (sql.includes("UPDATE company_mailbox_ingestion_overrides")) {
        const row = overrides.find((item) => item.id === binds[6]);
        if (row) {
          row.policy = binds[3];
          row.reason = binds[4] ?? row.reason;
          row.updated_at = binds[5];
        }
      }
      return { success: true };
    },
    first: async () => {
      if (sql.includes("FROM company_mailbox_ingestion_policies")) {
        return policies.find((row) => row.company_id === binds[0]) ?? null;
      }
      if (sql.includes("FROM company_mailbox_ingestion_overrides") && sql.includes("LIMIT 1")) {
        return (
          overrides.find(
            (row) =>
              row.company_id === binds[0] &&
              ((binds[1] && row.mailbox_id === binds[1]) ||
                (binds[3] && String(row.mailbox_address).toLowerCase() === String(binds[3]).toLowerCase()) ||
                (binds[5] && String(row.display_name).toLowerCase() === String(binds[5]).toLowerCase())),
          ) ?? null
        );
      }
      return null;
    },
    all: async () => {
      if (sql.includes("FROM users")) {
        return {
          results: users
            .filter((user) => memberships.some((m) => m.user_id === user.id && m.company_id === binds[0]))
            .map((user) => ({ id: user.id, email: user.email, display_name: user.display_name })),
        };
      }
      if (sql.includes("FROM company_mailbox_ingestion_overrides")) {
        return { results: overrides.filter((row) => row.company_id === binds[0]) };
      }
      return { results: [] };
    },
  });

  return {
    policies,
    overrides,
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => exec(sql, binds),
      ...exec(sql, []),
    }),
  } as unknown as D1Database & { policies: Row[]; overrides: Row[] };
}

describe("mailbox ingestion policy", () => {
  it("defaults EL to INCLUDE and other tenants to EXCLUDE", () => {
    expect(defaultIngestionPolicyForCompany("co_el")).toBe("INCLUDE");
    expect(defaultIngestionPolicyForCompany("co_caddington")).toBe("EXCLUDE");
    expect(defaultIngestionPolicyForCompany("co_ht")).toBe("EXCLUDE");
  });

  it("excludes William and Ella by person identity", () => {
    expect(matchesElvexExcludedPerson({ displayName: "William", mailboxAddress: "william@elvexpropertyservices.com" })?.name).toBe(
      "William",
    );
    expect(matchesElvexExcludedPerson({ displayName: "Ella Mae", mailboxAddress: "ella@elvexpropertyservices.com" })?.name).toBe(
      "Ella",
    );
    expect(matchesElvexExcludedPerson({ displayName: "Lauren", mailboxAddress: "lauren@elvexpropertyservices.com" })).toBeNull();
  });

  it("includes Lauren and a future EL user by default", async () => {
    const db = memoryDb();
    await seedElvexIngestionExclusions(db, "co_el");
    const lauren = await resolveMailboxIngestionPolicy(db, "co_el", {
      mailboxAddress: "lauren@elvexpropertyservices.com",
      displayName: "Lauren",
      userId: "user_lauren",
    });
    const future = await resolveMailboxIngestionPolicy(db, "co_el", {
      mailboxAddress: "newhire@elvexpropertyservices.com",
      displayName: "New Hire",
      userId: "user_new",
    });
    expect(lauren.effective).toBe("INCLUDE");
    expect(lauren.policy).toBe("INHERIT_DEFAULT");
    expect(future.effective).toBe("INCLUDE");
  });

  it("excludes William and Ella even when they inherit the default", async () => {
    const db = memoryDb();
    await seedElvexIngestionExclusions(db, "co_el");
    const william = await resolveMailboxIngestionPolicy(db, "co_el", {
      mailboxAddress: "william@elvexpropertyservices.com",
      displayName: "William",
      userId: "user_william",
      mailboxId: "user_william",
    });
    const ella = await resolveMailboxIngestionPolicy(db, "co_el", {
      mailboxAddress: "ella@elvexpropertyservices.com",
      displayName: "Ella Mae",
      userId: "user_ella",
    });
    expect(william.effective).toBe("EXCLUDE");
    expect(ella.effective).toBe("EXCLUDE");
  });

  it("keeps shared mailboxes on the default INCLUDE path", async () => {
    const db = memoryDb();
    await ensureCompanyIngestionPolicy(db, "co_el");
    const finance = await resolveMailboxIngestionPolicy(db, "co_el", {
      mailboxAddress: "finance@elvexpropertyservices.com",
      displayName: "EL Finance",
    });
    expect(finance.effective).toBe("INCLUDE");
  });

  it("does not apply the EL default to Caddington", async () => {
    const db = memoryDb();
    const policy = await ensureCompanyIngestionPolicy(db, "co_caddington");
    const user = await resolveMailboxIngestionPolicy(db, "co_caddington", {
      mailboxAddress: "ops@caddington.test",
      displayName: "Ops",
    });
    expect(policy).toBe("EXCLUDE");
    expect(user.effective).toBe("EXCLUDE");
  });

  it("honours an explicit INCLUDE override on an otherwise excluded mailbox", async () => {
    const db = memoryDb();
    await seedElvexIngestionExclusions(db, "co_el");
    await upsertIngestionOverride(db, {
      companyId: "co_el",
      mailboxAddress: "william@elvexpropertyservices.com",
      displayName: "William",
      policy: "INCLUDE",
      reason: "temporary test override",
    });
    const william = await resolveMailboxIngestionPolicy(db, "co_el", {
      mailboxAddress: "william@elvexpropertyservices.com",
      displayName: "William",
    });
    expect(william.effective).toBe("INCLUDE");
  });
});
