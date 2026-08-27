import { describe, expect, it, vi } from "vitest";

vi.mock("../xero", () => ({
  getValidXeroAccessToken: vi.fn(async () => ({
    ok: true,
    accessToken: "token",
    tenantId: "tenant",
  })),
}));

vi.mock("./xero-contact-resolve", () => ({
  resolveXeroContactForDraftInvoice: vi.fn(async () => ({
    ok: true,
    contact: { contactId: "contact-1", contactName: "Test Customer" },
  })),
}));

vi.mock("@infra/xero-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@infra/xero-core")>();
  return {
    ...actual,
    resolveSalesAccountCodeWithFetch: vi.fn(async (_config, input?: { accountCode?: string }) => {
      if (input?.accountCode === "99999") {
        throw new Error('Sales account code "99999" was not found in Xero.');
      }
      return { code: input?.accountCode ?? "200", name: "Sales", source: "explicit" as const };
    }),
    resolveXeroTaxTypeForDraftInvoice: vi.fn(async () => ({
      taxType: "NONE",
      label: "No VAT",
      source: "treatment",
    })),
  };
});

import { planXeroDraftInvoice } from "./xero-planner";

describe("planXeroDraftInvoice account validation", () => {
  it("rejects unknown explicit account codes at plan time", async () => {
    const result = await planXeroDraftInvoice({
      env: {} as never,
      companyId: "co_test",
      instanceId: "xero_1",
      actor: "test",
      contactName: "Test Customer",
      lineItems: [{ description: "line", quantity: 1, unitAmount: 0.01, accountCode: "99999" }],
    });

    expect(result.targets[0]?.validation).toBe("not_found");
    expect(result.targets[0]?.validationDetail).toContain("99999");
    expect(result.summary).toContain("sales account");
  });

  it("accepts valid explicit account codes", async () => {
    const result = await planXeroDraftInvoice({
      env: {} as never,
      companyId: "co_test",
      instanceId: "xero_1",
      actor: "test",
      contactName: "Test Customer",
      lineItems: [{ description: "line", quantity: 1, unitAmount: 1, accountCode: "200" }],
    });

    expect(result.targets[0]?.validation).toBe("valid");
    expect(result.targets[0]?.proposedState).toMatchObject({
      lineItems: [{ accountCode: "200" }],
    });
  });
});
