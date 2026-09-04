import { describe, expect, it } from "vitest";
import {
  buildTenantToolCatalogue,
  capabilityForPlatformTool,
  detectRequestedCapabilities,
  rewriteExactAccountingTool,
  rewriteHistoricalAccountingTool,
  normaliseVendorToolName,
  secondRbacAllows,
  standardToolContracts,
  tenantHasCapability,
  wantsMultiCapabilityRead,
} from "./company-tool-registry.js";
import { connectorOffersMailbox } from "./catalogue.js";

describe("company tool registry", () => {
  it("normalises vendor MCP names to stable INFRA tools", () => {
    expect(normaliseVendorToolName("analyse_xero_sales")).toBe("xero_sales_summary");
    expect(normaliseVendorToolName("get_sales_summary")).toBe("xero_sales_summary");
    expect(normaliseVendorToolName("search_emails")).toBe("outlook_search_mailbox");
    expect(normaliseVendorToolName("list_recent_files")).toBe("list_documents");
    expect(normaliseVendorToolName("list_company_documents")).toBe("list_documents");
    expect(normaliseVendorToolName("query_company_knowledge")).toBe("search_company_knowledge");
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

  it("Caddington Microsoft 365 plus Drive does not advertise EL Outlook", () => {
    const cad = buildTenantToolCatalogue({
      companyId: "co_caddington",
      connectors: ["conn_xero", "conn_google_drive", "conn_microsoft_365"],
      role: "company_admin",
    });
    expect(cad.tools).toEqual(expect.arrayContaining(["xero_sales_summary", "list_documents", "search_company_knowledge"]));
    expect(cad.tools.some((name) => name.startsWith("outlook_"))).toBe(false);
    expect(cad.capabilities).not.toContain("EMAIL_LIST");
    expect(connectorOffersMailbox("conn_microsoft_365")).toBe(false);
    expect(connectorOffersMailbox("conn_outlook_shared")).toBe(true);
    expect(connectorOffersMailbox("conn_microsoft")).toBe(true);
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
    expect(wantsMultiCapabilityRead("Xero sales this month, latest finance email")).toBe(true);
    expect(wantsMultiCapabilityRead("What is the sales process?")).toBe(false);
    expect(detectRequestedCapabilities("outstanding invoices")).toContain("ACCOUNTING_INVOICE_SEARCH");
    expect(detectRequestedCapabilities("profit and loss this month")).toContain("ACCOUNTING_REPORTS");
    expect(detectRequestedCapabilities("find invoice INV-1042")).toContain("ACCOUNTING_INVOICE_GET");
    expect(detectRequestedCapabilities("Look in the inbox for an invoice PDF")).toContain("EMAIL_SEARCH");
    expect(detectRequestedCapabilities("Look in the inbox for an invoice PDF")).not.toContain("ACCOUNTING_INVOICE_SEARCH");
    expect(wantsMultiCapabilityRead("Look in the inbox for an invoice PDF")).toBe(false);
    expect(detectRequestedCapabilities("Newest document")).toContain("CATALOGUE_LIST");
    expect(detectRequestedCapabilities("What were sales in March?")).toContain("ACCOUNTING_WAREHOUSE");
    expect(detectRequestedCapabilities("What are sales right now?")).toContain("ACCOUNTING_SALES");
    expect(detectRequestedCapabilities("What are sales right now?")).not.toContain("ACCOUNTING_WAREHOUSE");
    expect(capabilityForPlatformTool("outlook_search_mailbox")).toBe("EMAIL_SEARCH");
    expect(rewriteExactAccountingTool("xero_search_invoices", { query: "INV-02268" }, "Look up invoice INV-02268")).toEqual({
      name: "xero_get_invoice",
      arguments: { query: "INV-02268", invoiceNumber: "INV-02268" },
    });
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(rewriteHistoricalAccountingTool("xero_sales_summary", {}, "What were sales in March?", now).name).toBe(
      "warehouse_sales_analysis",
    );
    expect(rewriteHistoricalAccountingTool("xero_sales_summary", {}, "What are sales right now?", now).name).toBe(
      "xero_sales_summary",
    );
    expect(rewriteHistoricalAccountingTool("xero_get_invoice", { invoiceNumber: "INV-02268" }, "Has INV-02268 been paid?", now).name).toBe(
      "xero_get_invoice",
    );
    expect(
      rewriteHistoricalAccountingTool("xero_search_invoices", {}, "How many invoices did we raise in April?", now).name,
    ).toBe("warehouse_invoice_analysis");
    expect(
      rewriteHistoricalAccountingTool(
        "xero_list_overdue_invoices",
        {},
        "How has overdue debt moved over the last few months?",
        now,
      ).name,
    ).toBe("warehouse_receivables_analysis");
    expect(
      rewriteHistoricalAccountingTool(
        "xero_top_customers",
        {},
        "Who were the highest-value customers over this historical period?",
        now,
      ).name,
    ).toBe("warehouse_customer_analysis");
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
