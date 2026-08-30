import { describe, expect, it, vi, beforeEach } from "vitest";
import { XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE } from "@infra/shared";
import { AutomationActionError } from "./errors";

vi.mock("../../control-plane", () => ({
  getCompanyById: vi.fn(async () => ({
    id: "co_example",
    slug: "example",
    name: "Example Ltd",
  })),
  recordAuditEvent: vi.fn(),
}));

vi.mock("../../xero-read-execution", () => ({
  executeXeroReadToolOnInfra: vi.fn(),
}));

vi.mock("../../email/send-transactional", () => ({
  sendTransactionalEmail: vi.fn(),
}));

vi.mock("../../usage", () => ({
  recordUsageEvent: vi.fn(),
}));

import { executeXeroReadToolOnInfra } from "../../xero-read-execution";
import { sendTransactionalEmail } from "../../email/send-transactional";
import { executeXeroMonthToDateSalesEmail } from "./xero-sales-email";

const ctx = {
  companyId: "co_example",
  companySlug: "example",
  runId: "aur_1",
  initiatedBy: "admin@example.com",
  serviceIdentityId: null,
  automation: {
    id: "aut_1",
    companyId: "co_example",
    name: "Daily month-to-date sales",
    timezone: "Europe/London",
    configuration: {
      handler: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      parameters: { recipientEmail: "admin@example.com" },
    },
  },
} as never;

describe("xero month-to-date sales email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails without sending email when Xero is unavailable", async () => {
    vi.mocked(executeXeroReadToolOnInfra).mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "Xero disconnected",
    });

    await expect(executeXeroMonthToDateSalesEmail({} as never, ctx)).rejects.toMatchObject({
      code: "XERO_UNAVAILABLE",
      message: "We couldn't retrieve Xero sales data.",
    });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("does not send a fabricated zero-sales email", async () => {
    vi.mocked(executeXeroReadToolOnInfra).mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: "timeout",
    });
    try {
      await executeXeroMonthToDateSalesEmail({} as never, ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(AutomationActionError);
      expect((err as AutomationActionError).result?.totalSales).toBeUndefined();
    }
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("sends a company-aware report after a successful Xero read", async () => {
    vi.mocked(executeXeroReadToolOnInfra).mockResolvedValueOnce({
      ok: true,
      latencyMs: 12,
      result: {
        currencyCode: "GBP",
        summary: {
          fromDate: "2026-08-01",
          toDate: "2026-08-28",
          totalSales: 12345.67,
          currencyCode: "GBP",
        },
        transactions: [
          { qualifiesForSales: true, transactionType: "ACCREC", documentKind: "invoice" },
          { qualifiesForSales: true, transactionType: "ACCREC", documentKind: "invoice" },
          { qualifiesForSales: true, transactionType: "ACCRECCREDIT", documentKind: "credit_note" },
        ],
      },
    });
    vi.mocked(sendTransactionalEmail).mockResolvedValueOnce({
      id: "email_1",
      sent: true,
    });

    const result = await executeXeroMonthToDateSalesEmail(
      { PORTAL_PUBLIC_ORIGIN: "https://app.infrastack.app" } as never,
      ctx,
    );
    expect(result.summary).toBe("Sales report sent");
    expect(result.result.salesInvoiceCount).toBe(2);
    expect(result.result.recipientEmail).toBe("admin@example.com");
    expect(result.result.companyId).toBe("co_example");
    expect(vi.mocked(sendTransactionalEmail).mock.calls[0]?.[2]).toMatchObject({
      companyId: "co_example",
      type: "XERO_SALES_REPORT",
      recipient: "admin@example.com",
    });
    expect(String(vi.mocked(sendTransactionalEmail).mock.calls[0]?.[2]?.subject)).toContain(
      "Example Ltd",
    );
    expect(String(vi.mocked(executeXeroReadToolOnInfra).mock.calls[0]?.[1]?.companyId)).toBe(
      "co_example",
    );
  });

  it("keeps the calculated report when email delivery fails", async () => {
    vi.mocked(executeXeroReadToolOnInfra).mockResolvedValueOnce({
      ok: true,
      latencyMs: 8,
      result: {
        summary: { totalSales: 10, currencyCode: "GBP" },
        transactions: [],
      },
    });
    vi.mocked(sendTransactionalEmail).mockResolvedValueOnce({
      id: "email_2",
      sent: false,
      error: "graph failed",
    });

    await expect(executeXeroMonthToDateSalesEmail({} as never, ctx)).rejects.toMatchObject({
      code: "EMAIL_DELIVERY_FAILED",
      result: { xeroOk: true, totalSales: 10, emailSent: false },
    });
  });
});
