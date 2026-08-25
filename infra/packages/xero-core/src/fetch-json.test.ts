import { describe, expect, it, vi } from "vitest";
import { XeroApiError } from "./client";
import { mapXeroHttpError } from "./errors";
import { xeroGetJson } from "./fetch-json";

describe("mapXeroHttpError regression", () => {
  it("maps 403 scope failure", () => {
    const err = mapXeroHttpError(403, '{"Message":"Forbidden"}');
    expect(err.code).toBe("XERO_FORBIDDEN");
  });

  it("maps 429 rate limiting", () => {
    expect(mapXeroHttpError(429).code).toBe("XERO_RATE_LIMITED");
  });

  it("maps 500 provider outage", () => {
    const err = mapXeroHttpError(500, "Internal Server Error");
    expect(err.code).toBe("XERO_PROVIDER_UNAVAILABLE");
    expect(err.providerUnavailable).toBe(true);
  });

  it("maps malformed request detail", () => {
    const err = mapXeroHttpError(400, '{"Message":"fromDate must be before toDate"}');
    expect(err.code).toBe("XERO_REQUEST_FAILED");
    expect(err.message).toContain("fromDate");
  });
});

describe("xeroGetJson", () => {
  it("returns valid report JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ Reports: [{ ReportName: "Profit and Loss" }] }), {
        status: 200,
      }),
    );
    const body = await xeroGetJson<{ Reports?: Array<{ ReportName?: string }> }>(
      { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
      "/Reports/ProfitAndLoss",
      { fromDate: "2026-07-01", toDate: "2026-07-31" },
    );
    expect(body.Reports?.[0]?.ReportName).toBe("Profit and Loss");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/Reports/ProfitAndLoss");
  });

  it("maps 401 auth expiry", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    await expect(
      xeroGetJson(
        { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
        "/Reports/ProfitAndLoss",
      ),
    ).rejects.toMatchObject({
      provider: { code: "XERO_AUTH_EXPIRED" },
    });
  });

  it("maps network failures with internal detail", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      xeroGetJson(
        { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
        "/Reports/ProfitAndLoss",
      ),
    ).rejects.toBeInstanceOf(XeroApiError);
    await expect(
      xeroGetJson(
        { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
        "/Reports/ProfitAndLoss",
      ),
    ).rejects.toMatchObject({
      provider: {
        code: "XERO_PROVIDER_UNAVAILABLE",
        detail: "network down",
      },
    });
  });

  it("maps malformed JSON report bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(
      xeroGetJson(
        { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
        "/Reports/ProfitAndLoss",
      ),
    ).rejects.toMatchObject({
      provider: { code: "XERO_MALFORMED_RESPONSE" },
    });
  });
});
