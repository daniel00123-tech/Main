import { describe, expect, it } from "vitest";
import { EL_MAILBOX_SCAN_REPAIR_SUBJECT, renderMailboxScanRepairEmail } from "./mailbox-scan-repair-email";

describe("mailbox scan repair email", () => {
  it("uses the exact results subject", () => {
    const email = renderMailboxScanRepairEmail({
      overall: "PARTIAL",
      sections: [{ key: "B", title: "B. Current Graph auth", body: "FAIL" }],
      portalUrl: "https://app.infrastack.app/portal/el-business/automations",
    });
    expect(email.subject).toBe(EL_MAILBOX_SCAN_REPAIR_SUBJECT);
    expect(email.subject).toBe("INFRA — EL Mailbox Discovery & Attachment Ingestion Repair — Results");
    expect(email.text).toContain("B. Current Graph auth");
    expect(email.text).not.toMatch(/Caddington|co_caddington/i);
  });
});
