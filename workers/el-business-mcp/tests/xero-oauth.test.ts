import { describe, expect, it } from "vitest";
import {
  DEFAULT_XERO_REDIRECT_URI,
  XERO_SCOPES,
  XERO_SCOPE_STRING,
  organisationMatchesExpected,
  publicXeroPolicy,
  loadXeroConfig,
} from "../src/xero/config";
import { sanitizeErrorMessage } from "../src/xero/errors";
import { buildAuthorizeUrl } from "../src/xero/oauth";
import { selectElvexOrganisation } from "../src/xero/oauth";
import { previewDraftDocument } from "../src/xero/service";
import { computeAgeing, salesContribution, qualifiesAsPostedSales } from "../src/xero/reports";
import type { Env } from "../src/env";

function env(overrides: Partial<Env> = {}): Env {
  return {
    EL_BUSINESS_DATA: {} as D1Database,
    EL_XERO_CLIENT_ID: "454479535E074399A4D9A61AF4BD255F",
    EL_XERO_CLIENT_SECRET: "super-secret",
    EL_XERO_REDIRECT_URI: DEFAULT_XERO_REDIRECT_URI,
    ...overrides,
  };
}

describe("Xero configuration and scopes", () => {
  it("loads the existing Elvex Worker credentials and canonical redirect", () => {
    const loaded = loadXeroConfig(env())!;
    expect(loaded.clientId).toBe("454479535E074399A4D9A61AF4BD255F");
    expect(loaded.redirectUri).toBe("https://el-business-mcp.infrastack.app/oauth/xero/callback");
    expect(loaded.expectedOrganisation).toBe("Elvex Property Services Ltd");
  });

  it("requests granular scopes in one consent and never uses deprecated broad scopes", () => {
    expect(XERO_SCOPES).toContain("offline_access");
    expect(XERO_SCOPES).toContain("accounting.contacts");
    expect(XERO_SCOPES).toContain("accounting.invoices");
    expect(XERO_SCOPES).toContain("accounting.reports.profitandloss.read");
    expect(XERO_SCOPE_STRING).not.toContain("accounting.transactions");
    expect(XERO_SCOPE_STRING).not.toMatch(/(^|\s)accounting\.reports\.read(\s|$)/);
    expect(XERO_SCOPES).not.toContain("accounting.payments");
    expect(XERO_SCOPES).not.toContain("accounting.manualjournals");
  });

  it("builds a Xero authorize URL with state and PKCE", () => {
    const url = buildAuthorizeUrl(loadXeroConfig(env())!, "state-token", "challenge");
    expect(url.startsWith("https://login.xero.com/identity/connect/authorize")).toBe(true);
    expect(url).toContain("redirect_uri=https%3A%2F%2Fel-business-mcp.infrastack.app%2Foauth%2Fxero%2Fcallback");
    expect(url).toContain("state=state-token");
    expect(url).toContain("code_challenge=challenge");
    expect(url).not.toContain("super-secret");
  });

  it("never exposes tokens in the public policy", () => {
    const policy = publicXeroPolicy(loadXeroConfig(env()), {
      connected: true,
      organisationName: "Elvex Property Services Ltd",
      tenantId: "tenant-1",
      scopes: [...XERO_SCOPES],
      accessExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      lastRefreshAt: "2026-08-30T11:00:00Z",
      lastApiAt: "2026-08-30T11:01:00Z",
      lastApiOk: true,
    });
    const encoded = JSON.stringify(policy);
    expect(encoded).not.toContain("super-secret");
    expect(encoded).not.toMatch(/access_token|refresh_token|Bearer /);
    expect(policy.connected).toBe(true);
    expect(policy.tokenHealth).toBe("connected");
  });
});

describe("tenant isolation", () => {
  it("accepts the Elvex organisation and rejects others", () => {
    expect(organisationMatchesExpected("Elvex Property Services Ltd", "Elvex Property Services Ltd")).toBe(true);
    expect(organisationMatchesExpected("ELVEX PROPERTY SERVICES LTD", "Elvex Property Services Ltd")).toBe(true);
    expect(organisationMatchesExpected("Caddington Holdings Ltd", "Elvex Property Services Ltd")).toBe(false);
    const selected = selectElvexOrganisation(
      [
        { tenantId: "other", tenantName: "Caddington Holdings Ltd" },
        { tenantId: "elvex", tenantName: "Elvex Property Services Ltd" },
      ],
      "Elvex Property Services Ltd"
    );
    expect(selected.tenantId).toBe("elvex");
    expect(() =>
      selectElvexOrganisation([{ tenantId: "other", tenantName: "Caddington Holdings Ltd" }], "Elvex Property Services Ltd")
    ).toThrow(/not Elvex Property Services Ltd/);
  });
});

describe("error sanitisation", () => {
  it("redacts secrets and tokens", () => {
    expect(sanitizeErrorMessage("client_secret=abc refresh_token=xyz Bearer tok.en")).toContain("[redacted]");
    expect(sanitizeErrorMessage('{"refresh_token":"xyz","access_token":"abc"}')).not.toContain("xyz");
  });
});

describe("draft write safety", () => {
  it("previews a DRAFT invoice and does not mark it authorised", () => {
    const preview = previewDraftDocument({
      type: "ACCREC",
      kind: "invoice",
      contact: "Test Customer",
      lineItems: [{ description: "Callout", quantity: 1, unitAmount: 120 }],
    });
    expect(preview.status).toBe("DRAFT");
    expect(preview.estimatedTotalExTax).toBe(120);
    expect(preview.note).toMatch(/DRAFT only/);
  });
});

describe("sales and ageing maths", () => {
  it("subtracts credit notes and ignores drafts", () => {
    expect(salesContribution("ACCREC", 100)).toBe(100);
    expect(salesContribution("ACCRECCREDIT", 25)).toBe(-25);
    expect(qualifiesAsPostedSales("ACCREC", "AUTHORISED")).toBe(true);
    expect(qualifiesAsPostedSales("ACCREC", "DRAFT")).toBe(false);
    expect(qualifiesAsPostedSales("ACCPAY", "AUTHORISED")).toBe(false);
  });

  it("buckets overdue invoices without double-counting voided rows", () => {
    const report = computeAgeing(
      [
        {
          Type: "ACCREC",
          Status: "AUTHORISED",
          AmountDue: 50,
          DueDate: "2026-07-01",
          InvoiceNumber: "INV-1",
          Contact: { Name: "Customer A" },
        },
        {
          Type: "ACCREC",
          Status: "VOIDED",
          AmountDue: 999,
          DueDate: "2026-07-01",
          InvoiceNumber: "INV-VOID",
          Contact: { Name: "Customer A" },
        },
        {
          Type: "ACCPAY",
          Status: "AUTHORISED",
          AmountDue: 80,
          DueDate: "2026-07-01",
          InvoiceNumber: "BILL-1",
          Contact: { Name: "Supplier" },
        },
      ],
      "receivables",
      "2026-08-30"
    );
    expect(report.totalOutstanding).toBe(50);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]?.invoiceNumber).toBe("INV-1");
  });
});
