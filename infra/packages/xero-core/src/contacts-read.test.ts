import { describe, expect, it, vi } from "vitest";
import { buildXeroUrl } from "./fetch-json";
import { customerSafeXeroErrorMessage } from "./reports/profit-and-loss";
import { listContactsWithFetch } from "./tools/read";

describe("customerSafeXeroErrorMessage", () => {
  it("masks provider outage codes", () => {
    expect(
      customerSafeXeroErrorMessage("XERO_PROVIDER_UNAVAILABLE", "Internal detail"),
    ).toBe("Xero is temporarily unavailable.");
  });

  it("preserves validation-style request failures", () => {
    expect(customerSafeXeroErrorMessage("XERO_REQUEST_FAILED", "Bad where clause")).toBe(
      "Bad where clause",
    );
  });
});

describe("listContactsWithFetch", () => {
  it("queries Xero Contacts with Name.Contains and refines client-side", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/Contacts?");
      expect(url).toContain("where=");
      expect(url).toContain("Name.Contains");
      expect(url).toContain("Elvex");
      return new Response(
        JSON.stringify({
          Contacts: [
            { ContactID: "c1", Name: "Elvex Property Services Ltd", ContactStatus: "ACTIVE" },
            { ContactID: "c2", Name: "Unrelated Ltd", ContactStatus: "ACTIVE" },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await listContactsWithFetch(
      { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
      { query: "Elvex", limit: 10 },
    );

    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]?.Name).toBe("Elvex Property Services Ltd");
  });

  it("falls back to case-insensitive in-memory match when Xero Contains misses", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("where=")) {
        return new Response(JSON.stringify({ Contacts: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          Contacts: [
            { ContactID: "c1", Name: "ELVEX PROPERTY SERVICES LTD", ContactStatus: "ACTIVE" },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await listContactsWithFetch(
      { accessToken: "token", tenantId: "tenant", fetchImpl: fetchImpl as typeof fetch },
      { query: "Elvex", limit: 10 },
    );

    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]?.Name).toBe("ELVEX PROPERTY SERVICES LTD");
  });
});
