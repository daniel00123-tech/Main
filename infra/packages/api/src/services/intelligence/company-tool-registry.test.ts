import { describe, expect, it } from "vitest";
import {
  buildTenantToolCatalogue,
  capabilityForPlatformTool,
  detectRequestedCapabilities,
  normaliseVendorToolName,
  secondRbacAllows,
  standardToolContracts,
  tenantHasCapability,
  wantsMultiCapabilityRead,
} from "./company-tool-registry.js";

describe("company tool registry", () => {
  it("normalises vendor MCP names to stable INFRA tools", () => {
    expect(normaliseVendorToolName("analyse_xero_sales")).toBe("xero_sales_summary");
    expect(normaliseVendorToolName("search_emails")).toBe("outlook_search_mailbox");
    expect(normaliseVendorToolName("list_recent_files")).toBe("list_documents");
    expect(normaliseVendorToolName("xero_sales_summary")).toBe("xero_sales_summary");
  });

  it("gives every standard tool a complete contract", () => {
    const contracts = standardToolContracts();
    expect(contracts.length).toBeGreaterThan(10);
    for (const contract of contracts) {
      expect(contract.companyScope).toBe("tenant");
      expect(contract.capability).toBeTruthy();
      expect(contract.requiredPermission).toBeTruthy();
      expect(contract.readWrite).toMatch(/read|write/);
      expect(contract.billingAction).toBeTruthy();
      expect(contract.timeoutMs).toBeGreaterThan(0);
      expect(typeof contract.idempotent).toBe("boolean");
    }
  });

  it("EL catalogue includes connected Xero and Outlook only for that tenant", () => {
    const el = buildTenantToolCatalogue({
      companyId: "co_el",
      connectors: ["conn_xero", "conn_outlook_shared"],
      role: "director",
    });
    expect(el.tools).toEqual(expect.arrayContaining(["xero_sales_summary", "outlook_list_messages", "list_documents"]));
    expect(el.capabilities).toEqual(expect.arrayContaining(["ACCOUNTING_SALES", "EMAIL_LIST"]));
  });

  it("HT without connectors does not receive EL Xero or Outlook tools", () => {
    const ht = buildTenantToolCatalogue({ companyId: "co_ht", connectors: [], role: "director" });
    expect(ht.tools.some((name) => name.startsWith("xero_"))).toBe(false);
    expect(ht.tools.some((name) => name.startsWith("outlook_"))).toBe(false);
    expect(tenantHasCapability({ connectors: [], capability: "ACCOUNTING_SALES" })).toBe(false);
    expect(tenantHasCapability({ connectors: ["conn_xero"], capability: "ACCOUNTING_SALES" })).toBe(true);
  });

  it("office staff cannot take Xero even when the connector is present", () => {
    expect(
      secondRbacAllows({
        companyId: "co_el",
        role: "office_staff",
        connectors: ["conn_xero", "conn_outlook_shared"],
        toolName: "xero_sales_summary",
      }),
    ).toBe(false);
    expect(
      secondRbacAllows({
        companyId: "co_el",
        role: "director",
        connectors: ["conn_xero"],
        toolName: "xero_sales_summary",
      }),
    ).toBe(true);
  });

  it("detects generic multi-capability reads without company phrases", () => {
    expect(wantsMultiCapabilityRead("What are sales this month and what is the newest info email?")).toBe(true);
    expect(wantsMultiCapabilityRead("What are our sales and then show the latest finance email?")).toBe(true);
    expect(wantsMultiCapabilityRead("What are our Xero sales this month?")).toBe(false);
    expect(detectRequestedCapabilities("Newest document")).toContain("CATALOGUE_LIST");
    expect(capabilityForPlatformTool("outlook_search_mailbox")).toBe("EMAIL_SEARCH");
  });

  it("does not register future CRM capabilities until a connector exists", () => {
    const el = buildTenantToolCatalogue({
      companyId: "co_el",
      connectors: ["conn_xero"],
      role: "director",
    });
    expect(el.capabilities).not.toContain("JOB_SEARCH");
    expect(el.capabilities).not.toContain("TICKET_SEARCH");
    expect(tenantHasCapability({ connectors: ["conn_bigchange"], capability: "JOB_SEARCH" })).toBe(true);
  });
});
