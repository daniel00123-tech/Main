import { describe, expect, it } from "vitest";
import {
  EL_MAILBOX_ATTACHMENT_BACKFILL_SUBJECT,
  renderMailboxAttachmentBackfillEmail,
} from "./mailbox-attachment-backfill-email";

describe("mailbox attachment backfill email", () => {
  it("uses the exact results subject and per-mailbox exclusion lines", () => {
    const email = renderMailboxAttachmentBackfillEmail({
      windowFromLabel: "28 August 2026 20:00 Europe/London",
      windowToLabel: "4 September 2026 21:00 Europe/London",
      windowFromIso: "2026-08-28T19:00:00.000Z",
      windowToIso: "2026-09-04T20:00:00.000Z",
      graphAuth: "FAIL",
      graphDetail: "AADSTS7000229",
      defaultPolicy: "INCLUDE",
      exclusions: ["William", "Ella"],
      mailboxesDiscovered: 7,
      mailboxesEligible: 5,
      mailboxesScanned: 5,
      mailboxesExcluded: 2,
      messagesScanned: 40,
      messagesWithAttachments: 3,
      attachmentsDiscovered: 3,
      attachmentsFetched: 0,
      attachmentsStored: 0,
      attachmentsExtracted: 0,
      attachmentsIndexed: 0,
      chunksAdded: 0,
      duplicates: 0,
      skipped: 0,
      failed: 3,
      retrievalProof: "BLOCKED — Graph fetch/index did not complete",
      landingZone: "INFRA Knowledge Intake / Email Attachments",
      remainingIssues: ["Live Graph still failing"],
      people: [
        { name: "Michael", messagesScanned: 4, attachments: 0, indexed: 0, failed: 0 },
        { name: "Sharon", messagesScanned: 2, attachments: 0, indexed: 0, failed: 0 },
        { name: "Lauren", messagesScanned: 3, attachments: 0, indexed: 0, failed: 0 },
        { name: "finance@", messagesScanned: 10, attachments: 2, indexed: 0, failed: 2 },
        { name: "info@", messagesScanned: 9, attachments: 1, indexed: 0, failed: 1 },
        { name: "William", excluded: true },
        { name: "Ella", excluded: true },
      ],
      portalUrl: "https://app.infrastack.app/portal/el-business/automations",
    });
    expect(email.subject).toBe(EL_MAILBOX_ATTACHMENT_BACKFILL_SUBJECT);
    expect(email.text).toContain("Eligible mailboxes: 5");
    expect(email.text).toContain("Lauren");
    expect(email.text).toContain("William\nExcluded");
    expect(email.text).toContain("Ella\nExcluded");
    expect(email.text).not.toMatch(/Caddington|co_caddington/i);
  });
});
