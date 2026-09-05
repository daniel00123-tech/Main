import { describe, expect, it } from "vitest";
import { renderKnowledgeIngestionReportEmail } from "../email/knowledge-ingestion-email";
import {
  FORBIDDEN_CUSTOMER_JARGON,
  buildMicrosoftSyncReportEmailData,
  classifyMicrosoftSyncStatus,
  classifyReconciliationStage,
  customerCopyContainsForbiddenJargon,
  friendlyIngestionReason,
  friendlyMailboxLine,
  friendlySourceActivityLine,
  microsoftSyncReportSubject,
} from "./microsoft-sync-report";

const BASE = {
  companyDisplayName: "EL Business",
  reportDateLabel: "4 September 2026",
  windowFromLabel: "3 September 2026 08:00 Europe/London",
  windowToLabel: "4 September 2026 08:00 Europe/London",
  manual: false,
  runId: "aur_test",
  portalUrl: "https://app.infrastack.app/portal/el-business/automations",
};

const HEALTHY_MAILBOXES = [
  { name: "EL finance shared mailbox", approved: true, excluded: false, checked: true, failed: false },
  { name: "EL info shared mailbox", approved: true, excluded: false, checked: true, failed: false },
  { name: "Michael", approved: true, excluded: false, checked: true, failed: false },
  { name: "Sharon", approved: true, excluded: false, checked: true, failed: false },
  { name: "Lauren", approved: true, excluded: false, checked: true, failed: false },
  { name: "William", approved: false, excluded: true, checked: false, failed: false },
  { name: "Ella", approved: false, excluded: true, checked: false, failed: false },
];

const HEALTHY_DRIVE = { configured: true, checked: true, failed: false, newItemCount: 0 };

function render(partial: Parameters<typeof buildMicrosoftSyncReportEmailData>[0]) {
  const data = buildMicrosoftSyncReportEmailData(partial);
  const email = renderKnowledgeIngestionReportEmail(data);
  return { data, email };
}

function expectCustomerSafe(text: string) {
  expect(customerCopyContainsForbiddenJargon(text)).toBe(false);
  expect(text).not.toMatch(FORBIDDEN_CUSTOMER_JARGON);
  expect(text).not.toMatch(/vectoris|AADSTS|ATTACHMENT_ENUM_FAILED|MICROSOFT_TOKEN_DENIED|7000229|\bMCP\b|\bD1\b/i);
}

describe("Microsoft sync report reconciliation", () => {
  it("describes a successful scan with retryable attachments as checked, not error", () => {
    const line = friendlyMailboxLine({
      name: "Michael",
      approved: true,
      excluded: false,
      checked: true,
      failed: false,
      degraded: true,
      filesFound: 28,
      filesAdded: 26,
      filesRetrying: 2,
    });
    expect(line).toMatch(/Checked successfully/);
    expect(line).toMatch(/28 files found/);
    expect(line).toMatch(/26 added/);
    expect(line).toMatch(/2 will be retried/);
    expect(line).not.toMatch(/ERROR/i);
  });

  it("classifies FOUND → STORED → INDEXED and never treats stored-only as synchronised", () => {
    expect(classifyReconciliationStage({ indexed: false, stored: false })).toBe("FOUND");
    expect(classifyReconciliationStage({ indexed: false, stored: true })).toBe("STORED");
    expect(classifyReconciliationStage({ indexed: true, stored: true })).toBe("INDEXED");
  });

  it("maps internal codes to plain English", () => {
    expect(friendlyIngestionReason("AADSTS7000229")).toBe("Could not complete this source check.");
    expect(friendlyIngestionReason("MICROSOFT_TOKEN_DENIED")).toBe("Could not complete this source check.");
    expect(friendlyIngestionReason("ATTACHMENT_ENUM_FAILED")).toBe(
      "INFRA found the attachment but could not download it.",
    );
    expect(friendlyIngestionReason("unsupported format")).toBe("This file type is not supported yet.");
    expect(friendlyIngestionReason("duplicate")).toBe("This file is already in INFRA knowledge.");
    expect(friendlyIngestionReason("FAILED_RETRYABLE")).toBe(
      "A temporary problem occurred. INFRA will retry automatically.",
    );
    expect(friendlyIngestionReason("indexing failure")).toBe(
      "INFRA saved the file but could not add it to knowledge yet.",
    );
  });

  it("never reports zero activity when a source check failed", () => {
    expect(
      friendlySourceActivityLine({
        label: "OneDrive",
        check: { configured: true, checked: false, failed: true, newItemCount: 0 },
      }),
    ).toContain("Could not complete this source check.");
    expect(
      friendlySourceActivityLine({
        label: "OneDrive",
        check: { configured: true, checked: false, failed: true, newItemCount: 0 },
      }),
    ).not.toMatch(/0 (documents|files)|no new files/i);
  });
});

describe("Microsoft sync report email scenarios", () => {
  it("1 healthy day with a successfully synchronised file", () => {
    const { data, email } = render({
      ...BASE,
      documents: [
        {
          title: "Jobs.xlsx",
          sourceLabel: "OneDrive",
          indexed: true,
          stored: true,
          outcome: "indexed",
          modifiedAt: "2026-09-04T10:00:00.000Z",
          activityKind: "new",
          chunkCount: 8,
        },
      ],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: { ...HEALTHY_DRIVE, newItemCount: 1 },
      sharepoint: HEALTHY_DRIVE,
      chunkTotal: 8,
    });
    expect(data.status).toBe("HEALTHY");
    expect(email.subject).toBe("INFRA — EL Business Microsoft Sync Report — 4 September 2026");
    expect(email.text).toContain(
      "INFRA checked EL Business Microsoft 365 and knowledge sources this morning.",
    );
    expect(email.text).toContain("Added to INFRA knowledge");
    expect(email.text).toContain("Jobs.xlsx");
    expect(email.text).toContain("Searchable sections added: 8");
    expect(email.text).toContain("Michael: Checked");
    expect(email.text).toContain("Sharon: Checked");
    expect(email.text).toContain("Lauren: Checked");
    expect(email.text).toContain("William and Ella are not included, as requested.");
    expect(email.text).not.toContain("S6 Needs attention");
    expect(email.text).toContain("No action is required.");
    expectCustomerSafe(email.text);
    expectCustomerSafe(email.html);
  });

  it("lists approved Michael folders instead of a bare mailbox checked line", () => {
    const mailboxes = HEALTHY_MAILBOXES.map((row) =>
      row.name === "Michael"
        ? {
            ...row,
            folders: [
              { name: "Inbox", checked: true, failed: false },
              { name: "DAVIES GROUP INVOICES FOR SPREADSHEET", checked: true, failed: false },
              { name: "COMPLETED", checked: true, failed: false },
            ],
          }
        : row,
    );
    const { email } = render({
      ...BASE,
      documents: [],
      mailboxChecks: mailboxes,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(email.text).toContain("Michael — Checked:");
    expect(email.text).toContain("Inbox");
    expect(email.text).toContain("DAVIES GROUP INVOICES FOR SPREADSHEET");
    expect(email.text).toContain("COMPLETED");
    expect(email.text).toContain("Sharon: Checked");
    expect(email.html).toContain("DAVIES GROUP INVOICES FOR SPREADSHEET");
    expectCustomerSafe(email.text);
  });

  it("shows a failed approved folder separately", () => {
    const mailboxes = HEALTHY_MAILBOXES.map((row) =>
      row.name === "Michael"
        ? {
            ...row,
            failed: true,
            folders: [
              { name: "Inbox", checked: true, failed: false },
              { name: "COMPLETED", checked: false, failed: true },
            ],
          }
        : row,
    );
    const { email } = render({
      ...BASE,
      documents: [],
      mailboxChecks: mailboxes,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(email.text).toContain("Michael — Checked:");
    expect(email.text).toContain("Inbox");
    expect(email.text).toContain("Michael — COMPLETED: Could not be fully checked");
    expect(email.text).not.toContain("AADSTS");
    expectCustomerSafe(email.text);
  });

  it("2 no new files after a successful source check", () => {
    const { data, email } = render({
      ...BASE,
      documents: [],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(data.status).toBe("HEALTHY");
    expect(email.text).toContain("no new files");
    expect(email.text).toContain("New items found: 0");
    expect(email.text).toContain("INFRA knowledge now contains 0 new/updated documents");
    expect(email.text).not.toMatch(/Could not complete this source check/);
    expectCustomerSafe(email.text);
  });

  it("3 mailbox scan failure never shows 0 documents for that mailbox", () => {
    const mailboxes = HEALTHY_MAILBOXES.map((row) =>
      row.name === "Michael"
        ? { ...row, checked: false, failed: true, rawError: "AADSTS7000229" }
        : row,
    );
    const { data, email } = render({
      ...BASE,
      documents: [],
      mailboxChecks: mailboxes,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(data.status).toBe("NEEDS ATTENTION");
    expect(email.text).toContain("Michael: Could not be fully checked");
    expect(email.text).toContain("Could not complete this source check.");
    expect(email.text).not.toMatch(/Michael[^\n]*0/);
    expect(email.text).not.toContain("AADSTS7000229");
    expect(email.text).toContain("INFRA will automatically retry");
    expectCustomerSafe(email.text);
  });

  it("4 attachment discovered but not fetched", () => {
    const { data, email } = render({
      ...BASE,
      documents: [
        {
          title: "Quote.pdf",
          sourceLabel: "Email attachments",
          indexed: false,
          stored: false,
          outcome: "failed",
          failureReason: "ATTACHMENT_ENUM_FAILED",
          parentSubject: "Quote request",
        },
      ],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(data.status).toBe("NEEDS ATTENTION");
    expect(data.successfullyAdded).toBe(0);
    expect(email.text).toContain("INFRA found the attachment but could not download it.");
    expect(email.text).not.toContain("ATTACHMENT_ENUM_FAILED");
    expectCustomerSafe(email.text);
  });

  it("5 stored but index failed is not successfully synchronised", () => {
    const { data, email } = render({
      ...BASE,
      documents: [
        {
          title: "Invoice.pdf",
          sourceLabel: "Email attachments",
          indexed: false,
          stored: true,
          extracted: true,
          outcome: "failed",
          failureReason: "indexing failure",
        },
      ],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(classifyReconciliationStage({ indexed: false, stored: true, extracted: true, outcome: "failed" })).toBe(
      "STORED",
    );
    expect(data.successfullyAdded).toBe(0);
    expect(email.text).toContain("INFRA saved the file but could not add it to knowledge yet.");
    expect(email.text).not.toContain("Added to INFRA knowledge");
    expectCustomerSafe(email.text);
  });

  it("6 duplicate is found but not newly synchronised", () => {
    const { data, email } = render({
      ...BASE,
      documents: [
        {
          title: "Policy.docx",
          sourceLabel: "OneDrive",
          indexed: false,
          stored: true,
          outcome: "duplicate",
          failureReason: "duplicate",
        },
      ],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: { ...HEALTHY_DRIVE, newItemCount: 1 },
      sharepoint: HEALTHY_DRIVE,
    });
    expect(data.status).toBe("HEALTHY");
    expect(email.text).toContain("This file is already in INFRA knowledge.");
    expect(email.text).not.toContain("S6 Needs attention");
    expectCustomerSafe(email.text);
  });

  it("7 unsupported type", () => {
    const { email } = render({
      ...BASE,
      documents: [
        {
          title: "photo.heic",
          sourceLabel: "Email attachments",
          indexed: false,
          stored: true,
          outcome: "skipped",
          failureReason: "UNSUPPORTED_TYPE",
        },
      ],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(email.text).toContain("This file type is not supported yet.");
    expectCustomerSafe(email.text);
  });

  it("8 OneDrive failure never reports zero activity", () => {
    const { data, email } = render({
      ...BASE,
      documents: [],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: { configured: true, checked: false, failed: true, newItemCount: 0 },
      sharepoint: HEALTHY_DRIVE,
    });
    expect(data.status).toBe("NEEDS ATTENTION");
    expect(email.text).toContain("OneDrive: Could not complete this source check.");
    expect(email.text).not.toMatch(/OneDrive[^\n]*0 (documents|files)|OneDrive[^\n]*no new files/i);
    expectCustomerSafe(email.text);
  });

  it("9 SharePoint failure never reports zero activity", () => {
    const { email } = render({
      ...BASE,
      documents: [],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: HEALTHY_DRIVE,
      sharepoint: { configured: true, checked: false, failed: true, newItemCount: null },
    });
    expect(email.text).toContain("SharePoint: Could not complete this source check.");
    expect(email.text).not.toMatch(/SharePoint[^\n]*0 (documents|files)|SharePoint[^\n]*no new files/i);
    expectCustomerSafe(email.text);
  });

  it("10 retry in progress", () => {
    const { data, email } = render({
      ...BASE,
      documents: [
        {
          title: "Statement.pdf",
          sourceLabel: "Email attachments",
          indexed: false,
          stored: false,
          outcome: "failed",
          failureReason: "FAILED_RETRYABLE",
          retryCount: 1,
        },
      ],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(data.status).toBe("NEEDS ATTENTION");
    expect(data.stillProcessing).toBe(1);
    expect(email.text).toContain("A temporary problem occurred. INFRA will retry automatically.");
    expect(email.text).toContain("Still processing: 1");
    expect(email.text).toContain("INFRA will automatically retry");
    expect(email.text).toContain("Technical details");
    expect(email.text).toContain("Run: aur_test");
    expectCustomerSafe(email.text);
  });

  it("uses the test subject for a manual run and keeps tenant isolation", () => {
    const { email } = render({
      ...BASE,
      manual: true,
      documents: [],
      mailboxChecks: HEALTHY_MAILBOXES,
      onedrive: HEALTHY_DRIVE,
      sharepoint: HEALTHY_DRIVE,
    });
    expect(email.subject).toBe("INFRA — EL Business Microsoft Sync Report — Test");
    expect(microsoftSyncReportSubject({ ...BASE, manual: true })).toBe(
      "INFRA — EL Business Microsoft Sync Report — Test",
    );
    expect(email.text).toContain("daily 08:00 Europe/London schedule is unchanged");
    expect(email.text).not.toMatch(/Caddington|co_caddington|HT Business/i);
  });

  it("marks a total source-check failure as FAILED", () => {
    expect(
      classifyMicrosoftSyncStatus({
        jobOk: false,
        mailboxChecks: HEALTHY_MAILBOXES,
        onedrive: HEALTHY_DRIVE,
        sharepoint: HEALTHY_DRIVE,
        notSynchronisedFailed: 0,
        stillProcessing: 0,
      }),
    ).toBe("FAILED");
    expect(
      classifyMicrosoftSyncStatus({
        jobOk: true,
        mailboxChecks: HEALTHY_MAILBOXES.map((row) =>
          row.excluded ? row : { ...row, checked: false, failed: true },
        ),
        onedrive: { configured: true, checked: false, failed: true, newItemCount: null },
        sharepoint: { configured: true, checked: false, failed: true, newItemCount: null },
        notSynchronisedFailed: 0,
        stillProcessing: 0,
      }),
    ).toBe("FAILED");
  });
});
