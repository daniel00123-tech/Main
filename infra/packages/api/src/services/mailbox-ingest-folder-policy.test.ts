import { describe, expect, it } from "vitest";
import {
  EL_SEEDED_MAILBOX_FOLDER_APPROVALS,
  isDefaultExcludedFolder,
  isFolderCoveredByCurrentIngestPolicy,
  resolveApprovedIngestFolders,
  seedApprovedMailboxFolderPolicies,
} from "./mailbox-ingest-folder-policy";

describe("mailbox ingest folder policy", () => {
  it("always includes Inbox and never auto-enables Sent Items, Archive, or system folders", () => {
    const resolved = resolveApprovedIngestFolders({
      inbox: { id: "inbox-1", displayName: "Inbox" },
      listedFolders: [
        { id: "inbox-1", displayName: "Inbox" },
        { id: "sent-1", displayName: "Sent Items" },
        { id: "archive-1", displayName: "Archive" },
        { id: "deleted-1", displayName: "Deleted Items" },
        { id: "davies-1", displayName: "DAVIES GROUP INVOICES FOR SPREADSHEET" },
      ],
      enabledPolicies: [
        {
          id: "mfp_1",
          company_id: "co_el",
          mailbox_address: "michael@elvexpropertyservices.com",
          folder_id: "davies-1",
          folder_name: "DAVIES GROUP INVOICES FOR SPREADSHEET",
          enabled: 1,
          source: "seed",
          last_checkpoint: null,
          last_scan_at: null,
          last_messages_scanned: null,
          last_error: null,
          updated_at: "2026-09-05T00:00:00.000Z",
          created_at: "2026-09-05T00:00:00.000Z",
        },
        {
          id: "mfp_2",
          company_id: "co_el",
          mailbox_address: "michael@elvexpropertyservices.com",
          folder_id: null,
          folder_name: "Deleted Items",
          enabled: 1,
          source: "seed",
          last_checkpoint: null,
          last_scan_at: null,
          last_messages_scanned: null,
          last_error: null,
          updated_at: "2026-09-05T00:00:00.000Z",
          created_at: "2026-09-05T00:00:00.000Z",
        },
      ],
      includeSent: false,
      includeArchive: false,
      sent: { id: "sent-1", displayName: "Sent Items" },
      archive: { id: "archive-1", displayName: "Archive" },
    });
    expect(resolved.folders.map((folder) => folder.folderName)).toEqual([
      "Inbox",
      "DAVIES GROUP INVOICES FOR SPREADSHEET",
    ]);
    expect(resolved.folders.some((folder) => folder.kind === "sent")).toBe(false);
    expect(resolved.unresolved.some((row) => /Deleted Items/.test(row.folderName))).toBe(true);
  });

  it("does not hardcode Michael folders onto Sharon or other mailboxes", () => {
    expect(EL_SEEDED_MAILBOX_FOLDER_APPROVALS).toHaveLength(1);
    expect(EL_SEEDED_MAILBOX_FOLDER_APPROVALS[0]?.mailboxAddress).toBe("michael@elvexpropertyservices.com");
    expect(EL_SEEDED_MAILBOX_FOLDER_APPROVALS[0]?.includeSent).toBe(false);
    expect(EL_SEEDED_MAILBOX_FOLDER_APPROVALS.some((row) => /sharon|lauren|finance|info/i.test(row.mailboxAddress))).toBe(
      false,
    );
  });

  it("classifies default-excluded system folders", () => {
    expect(isDefaultExcludedFolder("Deleted Items")).toBe(true);
    expect(isDefaultExcludedFolder("Junk Email")).toBe(true);
    expect(isDefaultExcludedFolder("Drafts")).toBe(true);
    expect(isDefaultExcludedFolder("Conversation History")).toBe(true);
    expect(isDefaultExcludedFolder("COMPLETED")).toBe(false);
    expect(isDefaultExcludedFolder("Inbox")).toBe(false);
  });

  it("treats Inbox plus approved user folders as current ingest coverage", () => {
    const enabled = [
      { folder_name: "Inbox", folder_id: "inbox-1" },
      { folder_name: "DAVIES GROUP INVOICES FOR SPREADSHEET", folder_id: "davies-1" },
      { folder_name: "COMPLETED", folder_id: "completed-1" },
    ];
    expect(
      isFolderCoveredByCurrentIngestPolicy({
        folderName: "Inbox",
        folderId: "inbox-1",
        enabledFolders: enabled,
        includeSent: false,
        includeArchive: false,
      }),
    ).toBe(true);
    expect(
      isFolderCoveredByCurrentIngestPolicy({
        folderName: "DAVIES GROUP INVOICES FOR SPREADSHEET",
        folderId: "davies-1",
        enabledFolders: enabled,
        includeSent: false,
        includeArchive: false,
      }),
    ).toBe(true);
    expect(
      isFolderCoveredByCurrentIngestPolicy({
        folderName: "COMPLETED",
        folderId: "completed-1",
        enabledFolders: enabled,
        includeSent: false,
        includeArchive: false,
      }),
    ).toBe(true);
    expect(
      isFolderCoveredByCurrentIngestPolicy({
        folderName: "Sent Items",
        folderId: "sent-1",
        enabledFolders: enabled,
        includeSent: false,
        includeArchive: false,
      }),
    ).toBe(false);
    expect(
      isFolderCoveredByCurrentIngestPolicy({
        folderName: "Archive",
        folderId: "archive-1",
        enabledFolders: enabled,
        includeSent: false,
        includeArchive: false,
      }),
    ).toBe(false);
  });

  it("does not seed folder approvals for Caddington or HT", async () => {
    const inserts: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO company_mailbox_ingest_folders")) inserts.push(String(binds[2]));
            return { success: true };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    } as unknown as D1Database;
    await seedApprovedMailboxFolderPolicies(db, "co_caddington");
    await seedApprovedMailboxFolderPolicies(db, "co_ht");
    expect(inserts).toEqual([]);
  });
});
