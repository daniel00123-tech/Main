import { describe, expect, it, vi } from "vitest";
import { listAccountsWithFetch, searchInvoicesWithFetch } from "./tools/read";

describe("listAccountsWithFetch", () => {
  it("returns accounts from the Xero Accounts endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/Accounts");
      return new Response(
        JSON.stringify({
          Accounts: [{ Code: "200", Name: "Sales", Type: "REVENUE", TaxType: "NONE" }],
        }),
        { status: 200 },
      );
    });

    const result = await listAccountsWithFetch(
      { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
      {},
    );

    expect(result.accounts).toHaveLength(1);
    expect((result.accounts[0] as { Code?: string }).Code).toBe("200");
  });
});

describe("searchInvoicesWithFetch", () => {
  it("pages invoice search results via fetch", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/Invoices?");
      return new Response(
        JSON.stringify({
          Invoices: [{ InvoiceID: "inv-1", InvoiceNumber: "INV-001", Status: "DRAFT" }],
        }),
        { status: 200 },
      );
    });

    const result = await searchInvoicesWithFetch(
      { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
      { fromDate: "2026-08-01", toDate: "2026-08-31", limit: 5 },
    );

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.invoiceNumber).toBe("INV-001");
    expect(result.invoices[0]?.documentType).toBe("unknown");
  });
});
