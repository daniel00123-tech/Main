import { describe, expect, it } from "vitest";
import { elvexCan } from "@infra/shared";
import { resolveToolCapability } from "./bound-user-rbac";

describe("bound-user tool capability mapping", () => {
  it("allows William office_staff knowledge and info@ mail", () => {
    expect(elvexCan("office_staff", "knowledge.engineer.read")).toBe(true);
    expect(elvexCan("office_staff", "knowledge.company.read")).toBe(true);
    expect(elvexCan("office_staff", "mail.info.read")).toBe(true);
    expect(elvexCan("office_staff", "mail.info.write")).toBe(true);
    expect(resolveToolCapability("search_company_knowledge")).toBe("engineer_or_company");
    expect(resolveToolCapability("search_elvex_email", { mailbox: "info@elvexpropertyservices.com" })).toBe(
      "mail.info.read",
    );
  });

  it("denies William office_staff Xero, finance@, payments and admin", () => {
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("office_staff", "xero.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "mail.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "payment.info.access")).toBe(false);
    expect(elvexCan("office_staff", "admin.portal.access")).toBe(false);
    expect(elvexCan("office_staff", "admin.roles.manage")).toBe(false);
    expect(resolveToolCapability("search_xero_invoices")).toBe("xero.sales.read");
    expect(resolveToolCapability("search_elvex_email", { mailbox: "finance@elvexpropertyservices.com" })).toBe(
      "mail.finance.read",
    );
    expect(resolveToolCapability("get_xero_financial_summary")).toBe("xero.finance.read");
  });

  it("changes permissions when the role changes", () => {
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("finance_team", "xero.sales.read")).toBe(true);
    expect(elvexCan("finance_team", "mail.finance.read")).toBe(true);
    expect(elvexCan("company_admin", "admin.roles.manage")).toBe(true);
  });
});
