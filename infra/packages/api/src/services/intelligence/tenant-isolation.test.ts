import { describe, expect, it } from "vitest";
import { mergeEvidence } from "./evidence.js";
import {
  evidenceBelongsToCompany,
  isolateEvidenceForCompany,
  rejectCrossTenantMerge,
  stampEvidenceTenant,
} from "./tenant-isolation.js";

const EL_XERO = stampEvidenceTenant(
  {
    recentXero: {
      toolName: "xero_sales_summary",
      total: 5094,
      count: 32,
      fromDate: "2026-09-01",
      toDate: "2026-09-04",
      currency: "GBP",
      summary: "EL sales",
      label: "month",
    },
  },
  "co_el",
);

const CADDINGTON_EMAIL = stampEvidenceTenant(
  {
    recentEmail: {
      id: "cad_1",
      subject: "Caddington only",
      from: "ops@caddington.test",
      receivedDateTime: "2026-09-04T09:00:00Z",
      mailboxAddress: "info@caddington.test",
      body: "internal",
      toolName: "outlook_list_messages",
    },
  },
  "co_caddington",
);

describe("tenant evidence isolation", () => {
  it("stamps company_id on evidence", () => {
    expect(EL_XERO.companyId).toBe("co_el");
    expect(evidenceBelongsToCompany(EL_XERO, "co_el")).toBe(true);
    expect(evidenceBelongsToCompany(EL_XERO, "co_caddington")).toBe(false);
    expect(evidenceBelongsToCompany(EL_XERO, "co_ht")).toBe(false);
  });

  it("strips EL evidence when the session is Caddington", () => {
    const isolated = isolateEvidenceForCompany(EL_XERO, "co_caddington");
    expect(isolated.recentXero).toBeFalsy();
  });

  it("strips Caddington evidence when the session is EL", () => {
    const isolated = isolateEvidenceForCompany(CADDINGTON_EMAIL, "co_el");
    expect(isolated.recentEmail).toBeFalsy();
  });

  it("refuses to merge two companies' evidence", () => {
    expect(rejectCrossTenantMerge(EL_XERO, CADDINGTON_EMAIL)).toBe(true);
    const merged = mergeEvidence(EL_XERO, CADDINGTON_EMAIL);
    expect(merged.recentXero?.summary).toBe("EL sales");
    expect(merged.recentEmail).toBeFalsy();
  });

  it("keeps same-tenant merges", () => {
    const next = stampEvidenceTenant({ recentCatalogueItem: { id: "doc_1", title: "Policy" } }, "co_el");
    const merged = mergeEvidence(EL_XERO, next);
    expect(merged.recentXero?.total).toBe(5094);
    expect(merged.recentCatalogueItem?.id).toBe("doc_1");
    expect(merged.companyId).toBe("co_el");
  });

  it("HT cannot see EL or Caddington memory", () => {
    expect(isolateEvidenceForCompany(EL_XERO, "co_ht").recentXero).toBeFalsy();
    expect(isolateEvidenceForCompany(CADDINGTON_EMAIL, "co_ht").recentEmail).toBeFalsy();
  });
});
