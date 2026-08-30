import { describe, expect, it } from "vitest";
import {
  ELVEX_CANONICAL_ROLES,
  elvexCan,
  mapActionToElvexCapability,
} from "./elvex-rbac";

describe("INFRA Elvex RBAC overlay", () => {
  it("keeps explicit grants for all seven roles", () => {
    expect(ELVEX_CANONICAL_ROLES).toHaveLength(7);
    expect(elvexCan("engineer", "knowledge.engineer.read")).toBe(true);
    expect(elvexCan("engineer", "knowledge.company.read")).toBe(false);
    expect(elvexCan("office_staff", "mail.info.write")).toBe(true);
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("finance_team", "xero.finance.read")).toBe(true);
    expect(elvexCan("finance_team", "xero.draft.write")).toBe(false);
    expect(elvexCan("operations_manager", "xero.sales.read")).toBe(true);
    expect(elvexCan("operations_manager", "xero.finance.read")).toBe(false);
    expect(elvexCan("finance_manager", "xero.draft.write")).toBe(true);
    expect(elvexCan("finance_manager", "admin.roles.manage")).toBe(false);
    expect(elvexCan("director", "knowledge.restricted.read")).toBe(true);
    expect(elvexCan("director", "admin.roles.manage")).toBe(false);
    expect(elvexCan("company_admin", "admin.roles.manage")).toBe(true);
    expect(elvexCan("company_admin", "payment.info.access")).toBe(true);
  });

  it("maps Xero P&L to finance read and drafts to write", () => {
    expect(mapActionToElvexCapability("xero.reports.profit_and_loss")).toBe("xero.finance.read");
    expect(mapActionToElvexCapability("xero.invoices.create_draft")).toBe("xero.draft.write");
    expect(mapActionToElvexCapability("knowledge.search")).toBe("engineer_or_company");
  });

  it("unknown roles fail closed", () => {
    expect(elvexCan("supervisor", "knowledge.company.read")).toBe(false);
    expect(elvexCan(null, "system.health")).toBe(false);
  });
});
