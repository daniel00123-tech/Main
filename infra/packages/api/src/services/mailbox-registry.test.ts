import { describe, expect, it } from "vitest";
import {
  policySeedsForCompany,
  upsertMailboxRegistryRow,
  listApprovedAttachmentMailboxes,
  registerDiscoveredUserMailbox,
} from "./mailbox-registry";

function memoryDb() {
  const rows: Array<Record<string, unknown>> = [];
  const exec = (sql: string, binds: unknown[]) => ({
    run: async () => {
      if (sql.includes("CREATE TABLE")) return { success: true };
      if (sql.includes("INSERT INTO company_mailbox_registry")) {
        rows.push({
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
          last_error: null,
          metadata_json: binds[10],
        });
      }
      if (sql.includes("UPDATE company_mailbox_registry SET")) {
        const id = binds[binds.length - 2];
        const row = rows.find((item) => item.id === id);
        if (row) {
          row.mailbox_type = binds[1];
          row.enabled_for_mail_search = binds[3];
          row.enabled_for_attachment_ingestion = binds[4];
        }
      }
      return { success: true };
    },
    first: async () => {
      if (sql.includes("SELECT id FROM company_mailbox_registry")) {
        const address = String(binds[1] ?? "").toLowerCase();
        return rows.find((row) => String(row.mailbox_address).toLowerCase() === address) ?? null;
      }
      return null;
    },
    all: async () => {
      const companyId = binds[0];
      const filtered = rows.filter((row) => row.company_id === companyId);
      if (sql.includes("enabled_for_attachment_ingestion = 1")) {
        return { results: filtered.filter((row) => row.enabled_for_attachment_ingestion === 1) };
      }
      return { results: filtered };
    },
  });
  return {
    rows,
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => exec(sql, binds),
      ...exec(sql, []),
    }),
  } as unknown as D1Database & { rows: Array<Record<string, unknown>> };
}

describe("mailbox ingestion registry", () => {
  it("seeds EL shared policy mailboxes without hardcoding them into generic list logic", () => {
    const seeds = policySeedsForCompany("co_el");
    expect(seeds).toHaveLength(4);
    expect(seeds.every((seed) => seed.enabledForAttachmentIngestion)).toBe(true);
    expect(seeds.filter((seed) => seed.mailboxType === "user_mailbox").map((seed) => seed.mailboxAddress)).toEqual([
      "michael@elvexpropertyservices.com",
      "sharon@elvexpropertyservices.com",
    ]);
    expect(seeds.filter((seed) => seed.mailboxType === "user_mailbox").every((seed) => seed.enabledForMailSearch === false)).toBe(
      true,
    );
    expect(policySeedsForCompany("co_caddington")).toEqual([]);
    expect(policySeedsForCompany("co_ht")).toEqual([]);
  });

  it("does not auto-enable unapproved personal user mailboxes for attachment ingestion", async () => {
    const db = memoryDb();
    await registerDiscoveredUserMailbox(db, {
      companyId: "co_el",
      mailboxAddress: "lauren@elvexpropertyservices.com",
      displayName: "Lauren",
      role: "office_staff",
    });
    const approved = await listApprovedAttachmentMailboxes(db, "co_other");
    expect(approved).toEqual([]);
    const lauren = (db as unknown as { rows: Array<Record<string, unknown>> }).rows.find(
      (row) => row.mailbox_address === "lauren@elvexpropertyservices.com",
    );
    expect(lauren?.enabled_for_attachment_ingestion).toBe(0);
    expect(lauren?.company_id).toBe("co_el");
  });

  it("keeps registry rows tenant-scoped", async () => {
    const db = memoryDb();
    await upsertMailboxRegistryRow(db, "co_el", {
      mailboxAddress: "info@elvexpropertyservices.com",
      mailboxType: "shared_mailbox",
      enabledForMailSearch: true,
      enabledForAttachmentIngestion: true,
      sensitivity: "company_operational",
    });
    await upsertMailboxRegistryRow(db, "co_other", {
      mailboxAddress: "info@other.test",
      mailboxType: "shared_mailbox",
      enabledForMailSearch: true,
      enabledForAttachmentIngestion: true,
      sensitivity: "company_operational",
    });
    const el = await listApprovedAttachmentMailboxes(db, "co_el");
    expect(el.map((row) => row.mailbox_address)).toEqual(
      expect.arrayContaining(["info@elvexpropertyservices.com"]),
    );
    expect(el.every((row) => row.company_id === "co_el")).toBe(true);
    expect(el.some((row) => row.mailbox_address === "info@other.test")).toBe(false);
  });
});
