import { describe, expect, it } from "vitest";
import {
  elvexAllowsAction,
  elvexCan,
  elvexMailboxCapability,
  isElvexCompany,
  mapActionToElvexCapability,
  resolveElvexConfiguredMailbox,
} from "./elvex-rbac";

describe("Elvex RBAC overlay", () => {
  it("identifies the EL Business company only", () => {
    expect(isElvexCompany({ id: "co_el" })).toBe(true);
    expect(isElvexCompany({ slug: "el-business" })).toBe(true);
    expect(isElvexCompany({ id: "co_ht", slug: "ht-business" })).toBe(false);
  });

  it("allows office_staff knowledge and info@, denies Xero and finance@", () => {
    expect(elvexCan("office_staff", "knowledge.engineer.read")).toBe(true);
    expect(elvexCan("office_staff", "knowledge.company.read")).toBe(true);
    expect(elvexCan("office_staff", "mail.info.read")).toBe(true);
    expect(elvexCan("office_staff", "mail.info.write")).toBe(true);
    expect(elvexCan("office_staff", "mail.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("office_staff", "xero.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "admin.roles.manage")).toBe(false);
    expect(elvexCan("office_staff", "payment.info.access")).toBe(false);

    expect(elvexAllowsAction("office_staff", "knowledge.search").allowed).toBe(true);
    expect(elvexAllowsAction("office_staff", "xero.invoices.read").allowed).toBe(false);
    expect(
      elvexAllowsAction("office_staff", "outlook.search", {
        mailboxAddress: "info@elvexpropertyservices.com",
      }).allowed,
    ).toBe(true);
    expect(
      elvexAllowsAction("office_staff", "outlook.search", {
        mailboxAddress: "finance@elvexpropertyservices.com",
      }).allowed,
    ).toBe(false);
  });

  it("grants finance_team Xero read and finance mail", () => {
    expect(elvexCan("finance_team", "xero.sales.read")).toBe(true);
    expect(elvexCan("finance_team", "xero.finance.read")).toBe(true);
    expect(elvexCan("finance_team", "mail.finance.read")).toBe(true);
    expect(elvexCan("finance_team", "xero.draft.write")).toBe(false);
    expect(elvexAllowsAction("finance_team", "xero.invoices.read").allowed).toBe(true);
  });

  it("maps mailboxes and unknown privileged actions fail closed", () => {
    expect(elvexMailboxCapability("finance@elvexpropertyservices.com", false)).toBe(
      "mail.finance.read",
    );
    expect(elvexMailboxCapability("info@elvexpropertyservices.com", true)).toBe("mail.info.write");
    expect(elvexMailboxCapability("info inbox", false)).toBe("mail.info.read");
    expect(elvexMailboxCapability("finance inbox", false)).toBe("mail.finance.read");
    expect(elvexMailboxCapability("private@elvexpropertyservices.com", false)).toBeNull();
    expect(mapActionToElvexCapability("mcp.secret_admin")).toBeNull();
    expect(elvexAllowsAction("office_staff", "mcp.secret_admin").allowed).toBe(false);
    expect(resolveElvexConfiguredMailbox("info inbox")).toBe("info@elvexpropertyservices.com");
    expect(resolveElvexConfiguredMailbox("finance@elvexpropertyservices.com")).toBe(
      "finance@elvexpropertyservices.com",
    );
  });
});
