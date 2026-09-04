import { describe, expect, it } from "vitest";
import {
  discoverCompanyUserMailboxes,
  listApprovedAttachmentMailboxes,
  listExcludedAttachmentMailboxes,
  policySeedsForCompany,
  registerDiscoveredUserMailbox,
  upsertMailboxRegistryRow,
} from "./mailbox-registry";

type Row = Record<string, unknown>;

function memoryEnv(companyId = "co_el") {
  const registry: Row[] = [];
  const policies: Row[] = [];
  const overrides: Row[] = [];
  const users: Row[] = [
    { id: "user_william", email: "william@elvexpropertyservices.com", display_name: "William", role: "director" },
    { id: "user_ella", email: "ella@elvexpropertyservices.com", display_name: "Ella Mae", role: "director" },
    { id: "user_lauren", email: "lauren@elvexpropertyservices.com", display_name: "Lauren", role: "office_staff" },
    { id: "user_michael", email: "michael@elvexpropertyservices.com", display_name: "Michael", role: "finance_team" },
    { id: "user_sharon", email: "sharon@elvexpropertyservices.com", display_name: "Sharon", role: "office_staff" },
    { id: "user_daniel", email: "daniel.dwyer123@gmail.com", display_name: "Daniel", role: "company_admin" },
    { id: "user_new", email: "alex@elvexpropertyservices.com", display_name: "Alex", role: "office_staff" },
  ];

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
        });
      }
      if (sql.includes("UPDATE company_mailbox_ingestion_overrides")) {
        const row = overrides.find((item) => item.id === binds[6]);
        if (row) row.policy = binds[3];
      }
      if (sql.includes("INSERT INTO company_mailbox_registry")) {
        registry.push({
          id: binds[0],
          company_id: binds[1],
          mailbox_id: binds[2],
          mailbox_address: binds[3],
          mailbox_type: binds[4],
          display_name: binds[5],
          enabled_for_mail_search: binds[6],
          enabled_for_attachment_ingestion: binds[7],
          sensitivity: binds[8],
          status: binds[9],
          graph_accessible: null,
          last_checkpoint: null,
          last_successful_sync: null,
          last_attachment_scan_at: null,
          last_messages_scanned: null,
          last_error: null,
          metadata_json: binds[10],
        });
      }
      if (sql.includes("UPDATE company_mailbox_registry SET") && sql.includes("enabled_for_mail_search")) {
        const id = binds[binds.length - 2];
        const row = registry.find((item) => item.id === id);
        if (row) {
          row.mailbox_type = binds[1];
          row.display_name = binds[2] ?? row.display_name;
          row.enabled_for_mail_search = binds[3];
          row.enabled_for_attachment_ingestion = binds[4];
          row.status = binds[6] ?? row.status;
        }
      }
      if (sql.includes("UPDATE company_mailbox_registry") && sql.includes("enabled_for_attachment_ingestion = ?")) {
        const row = registry.find((item) => item.id === binds[3]);
        if (row) {
          row.enabled_for_attachment_ingestion = binds[0];
          row.status = binds[1];
        }
      }
      if (sql.includes("UPDATE company_mailbox_registry") && sql.includes("status = 'denied'")) {
        const row = registry.find((item) => item.id === binds[1]);
        if (row) {
          row.enabled_for_attachment_ingestion = 0;
          row.status = "denied";
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
                (binds[3] && String(row.mailbox_address ?? "").toLowerCase() === String(binds[3]).toLowerCase()) ||
                (binds[5] && String(row.display_name ?? "").toLowerCase() === String(binds[5]).toLowerCase())),
          ) ?? null
        );
      }
      if (sql.includes("FROM company_mailbox_registry") && sql.includes("LIMIT 1")) {
        const address = String(binds[1] ?? "").toLowerCase();
        const row = registry.find(
          (item) => item.company_id === binds[0] && String(item.mailbox_address).toLowerCase() === address,
        );
        return row ? { id: row.id, enabled_for_attachment_ingestion: row.enabled_for_attachment_ingestion } : null;
      }
      return null;
    },
    all: async () => {
      if (sql.includes("FROM users")) {
        return {
          results: users
            .filter((user) => (user.email as string).includes("elvex") || (user.email as string).includes("gmail"))
            .filter(() => companyId === binds[0] || binds[0] === "co_el")
            .map((user) => ({
              id: user.id,
              email: user.email,
              display_name: user.display_name,
              role: user.role,
            })),
        };
      }
      if (sql.includes("FROM company_mailbox_ingestion_overrides")) {
        return { results: overrides.filter((row) => row.company_id === binds[0]) };
      }
      const filtered = registry.filter((row) => row.company_id === binds[0]);
      if (sql.includes("enabled_for_attachment_ingestion = 1")) {
        return { results: filtered.filter((row) => row.enabled_for_attachment_ingestion === 1) };
      }
      if (sql.includes("enabled_for_attachment_ingestion = 0")) {
        return { results: filtered.filter((row) => row.enabled_for_attachment_ingestion === 0) };
      }
      return { results: filtered };
    },
  });

  const db = {
    registry,
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => exec(sql, binds),
      ...exec(sql, []),
    }),
  } as unknown as D1Database & { registry: Row[] };
  return { db, registry };
}

describe("mailbox ingestion registry", () => {
  it("seeds only EL shared operational mailboxes", () => {
    const seeds = policySeedsForCompany("co_el");
    expect(seeds).toHaveLength(2);
    expect(seeds.map((seed) => seed.mailboxAddress)).toEqual([
      "info@elvexpropertyservices.com",
      "finance@elvexpropertyservices.com",
    ]);
    expect(seeds.every((seed) => seed.mailboxType === "shared_mailbox")).toBe(true);
    expect(policySeedsForCompany("co_caddington")).toEqual([]);
    expect(policySeedsForCompany("co_ht")).toEqual([]);
  });

  it("includes Lauren automatically and excludes William and Ella", async () => {
    const { db, registry } = memoryEnv();
    await registerDiscoveredUserMailbox(db, {
      companyId: "co_el",
      mailboxAddress: "lauren@elvexpropertyservices.com",
      displayName: "Lauren",
      userId: "user_lauren",
      mailboxId: "user_lauren",
    });
    await registerDiscoveredUserMailbox(db, {
      companyId: "co_el",
      mailboxAddress: "william@elvexpropertyservices.com",
      displayName: "William",
      userId: "user_william",
      mailboxId: "user_william",
    });
    await registerDiscoveredUserMailbox(db, {
      companyId: "co_el",
      mailboxAddress: "ella@elvexpropertyservices.com",
      displayName: "Ella Mae",
      userId: "user_ella",
      mailboxId: "user_ella",
    });
    const approved = await listApprovedAttachmentMailboxes(db, "co_el");
    const excluded = await listExcludedAttachmentMailboxes(db, "co_el");
    expect(approved.map((row) => row.mailbox_address)).toEqual(
      expect.arrayContaining([
        "info@elvexpropertyservices.com",
        "finance@elvexpropertyservices.com",
        "lauren@elvexpropertyservices.com",
      ]),
    );
    expect(approved.some((row) => row.mailbox_address.startsWith("william@"))).toBe(false);
    expect(approved.some((row) => row.mailbox_address.startsWith("ella@"))).toBe(false);
    expect(excluded.map((row) => row.mailbox_address)).toEqual(
      expect.arrayContaining(["william@elvexpropertyservices.com", "ella@elvexpropertyservices.com"]),
    );
    expect(registry.find((row) => row.mailbox_address === "lauren@elvexpropertyservices.com")?.enabled_for_attachment_ingestion).toBe(
      1,
    );
  });

  it("includes a newly discovered EL user without a deploy-time allowlist", async () => {
    const { db } = memoryEnv();
    const discovered = await discoverCompanyUserMailboxes({ DB: db } as never, "co_el");
    expect(discovered.some((row) => row.mailboxAddress === "alex@elvexpropertyservices.com")).toBe(true);
    expect(discovered.some((row) => row.mailboxAddress.endsWith("@gmail.com"))).toBe(false);
    const approved = await listApprovedAttachmentMailboxes(db, "co_el");
    expect(approved.some((row) => row.mailbox_address === "alex@elvexpropertyservices.com")).toBe(true);
    expect(approved.some((row) => row.mailbox_address === "michael@elvexpropertyservices.com")).toBe(true);
    expect(approved.some((row) => row.mailbox_address === "sharon@elvexpropertyservices.com")).toBe(true);
    expect(approved.some((row) => row.mailbox_address.startsWith("william@"))).toBe(false);
  });

  it("keeps registry rows tenant-scoped and does not include another tenant", async () => {
    const { db } = memoryEnv();
    await upsertMailboxRegistryRow(db, "co_other", {
      mailboxAddress: "info@other.test",
      mailboxType: "shared_mailbox",
      enabledForMailSearch: true,
      enabledForAttachmentIngestion: true,
      sensitivity: "company_operational",
    });
    const el = await listApprovedAttachmentMailboxes(db, "co_el");
    expect(el.every((row) => row.company_id === "co_el")).toBe(true);
    expect(el.some((row) => row.mailbox_address === "info@other.test")).toBe(false);
  });

  it("does not auto-include a Caddington user mailbox", async () => {
    const { db } = memoryEnv("co_caddington");
    await registerDiscoveredUserMailbox(db, {
      companyId: "co_caddington",
      mailboxAddress: "ops@caddington.test",
      displayName: "Ops",
    });
    const approved = await listApprovedAttachmentMailboxes(db, "co_caddington");
    expect(approved).toEqual([]);
  });
});
