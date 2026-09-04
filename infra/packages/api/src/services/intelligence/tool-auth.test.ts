import { describe, expect, it } from "vitest";
import { authorizeToolCall, buildAllowedToolCatalogue } from "./tool-auth.js";

const CONNECTORS = ["conn_xero", "conn_outlook_shared", "conn_microsoft"];

describe("pre-auth catalogue and second tool-auth", () => {
  it("hides Xero from office_staff before the model sees tools", () => {
    const tools = buildAllowedToolCatalogue({
      role: "office_staff",
      companyId: "co_el",
      connectors: CONNECTORS,
    });
    expect(tools.some((name) => name.startsWith("xero_"))).toBe(false);
    expect(tools).toContain("outlook_list_messages");
    expect(tools).toContain("web_search");
    expect(tools).toContain("search_company_knowledge");
  });

  it("gives directors Xero and mailbox reads", () => {
    const tools = buildAllowedToolCatalogue({
      role: "director",
      companyId: "co_el",
      connectors: CONNECTORS,
    });
    expect(tools).toContain("xero_sales_summary");
    expect(tools).toContain("outlook_list_messages");
  });

  it("denies office_staff Xero even if the model asks", () => {
    const permitted = buildAllowedToolCatalogue({
      role: "office_staff",
      companyId: "co_el",
      connectors: CONNECTORS,
    });
    const decision = authorizeToolCall(
      { role: "office_staff", companyId: "co_el", connectors: CONNECTORS, permittedTools: permitted },
      { name: "xero_sales_summary", arguments: {} },
    );
    expect(decision.allowed).toBe(false);
  });

  it("denies office_staff finance mailbox and allows info mailbox", () => {
    const permitted = buildAllowedToolCatalogue({
      role: "office_staff",
      companyId: "co_el",
      connectors: CONNECTORS,
    });
    const finance = authorizeToolCall(
      { role: "office_staff", companyId: "co_el", connectors: CONNECTORS, permittedTools: permitted },
      { name: "outlook_list_messages", arguments: { mailboxAddress: "finance@elvexpropertyservices.com" } },
    );
    const info = authorizeToolCall(
      { role: "office_staff", companyId: "co_el", connectors: CONNECTORS, permittedTools: permitted },
      { name: "outlook_list_messages", arguments: { mailboxAddress: "info@elvexpropertyservices.com" } },
    );
    expect(finance.allowed).toBe(false);
    expect(info.allowed).toBe(true);
  });

  it("never authorises write tools", () => {
    const decision = authorizeToolCall(
      {
        role: "director",
        companyId: "co_el",
        connectors: CONNECTORS,
        permittedTools: ["outlook_send_message"],
      },
      { name: "outlook_send_message", arguments: {} },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("writes_forbidden");
  });

  it("blocks public web for private business queries", () => {
    const decision = authorizeToolCall(
      { role: "director", companyId: "co_el", connectors: CONNECTORS, permittedTools: ["web_search"] },
      { name: "web_search", arguments: { query: "our Xero sales this month" } },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("private_systems_outrank_public_web");
  });
});
