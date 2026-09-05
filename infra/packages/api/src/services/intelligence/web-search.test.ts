import { describe, expect, it } from "vitest";
import { isPrivateBusinessWebQuery, looksLikePublicWebAsk, sanitisePublicWebQuery, verbaliseWebSearch } from "./web-search.js";

describe("public web search guards", () => {
  it("routes weather to public web and holiday entitlement to internal knowledge", () => {
    expect(looksLikePublicWebAsk("what's the weather in London")).toBe(true);
    expect(looksLikePublicWebAsk("what is our holiday entitlement")).toBe(false);
    expect(isPrivateBusinessWebQuery("holiday entitlement")).toBe(true);
  });

  it("never treats Xero or Outlook as public web", () => {
    expect(looksLikePublicWebAsk("Xero sales this month")).toBe(false);
    expect(looksLikePublicWebAsk("newest email in the info inbox")).toBe(false);
    expect(isPrivateBusinessWebQuery("sharepoint vehicle policy")).toBe(true);
  });

  it("verbalises public results without inventing figures", () => {
    const text = verbaliseWebSearch(
      { heading: "London", abstract: "Public weather is available from national forecasts." },
      "weather London",
    );
    expect(text).toMatch(/London|forecast/i);
    expect(text).not.toMatch(/£/);
  });

  it("strips invoices, mailboxes and long quoted bodies from public queries", () => {
    expect(sanitisePublicWebQuery("weather tomorrow INV-02277 ella@elvexpropertyservices.com")).toBe("weather tomorrow");
    expect(sanitisePublicWebQuery(`public fact "${"secret body ".repeat(20)}"`)).not.toMatch(/secret body/);
  });
});
