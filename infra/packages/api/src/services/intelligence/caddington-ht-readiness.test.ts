import { describe, expect, it } from "vitest";
import { resolveBrainPolicy } from "./brain-policy.js";
import { buildTenantToolCatalogue, tenantHasCapability } from "./company-tool-registry.js";
import { isolateEvidenceForCompany } from "./tenant-isolation.js";
import { resolveRequestPricingPolicy } from "../customer-request-pricing.js";

const SHADOW_ENV = {
  OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
  OPENAI_BRAIN_ENABLED: "true",
  OPENAI_BRAIN_MODE: "openai_shadow",
  OPENAI_BRAIN_COMPANY_IDS: "co_el",
};

const CADDINGTON_ENV = {
  ...SHADOW_ENV,
  OPENAI_BRAIN_COMPANY_IDS: "co_el,co_caddington",
};

describe("Caddington shared-architecture readiness", () => {
  it("promotes PA/request onto OpenAI while keeping ChatGPT direct and pricing unchanged", () => {
    const unscoped = resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: "co_caddington" });
    expect(unscoped.mode).toBe("openai_shadow");
    expect(unscoped.useOpenAi).toBe(false);
    expect(unscoped.shadow).toBe(true);

    const pa = resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: "co_caddington", channel: "portal" });
    expect(pa.useOpenAi).toBe(true);
    expect(pa.userVisibleBrain).toBe("openai");
    expect(resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: "co_caddington", channel: "whatsapp" }).useOpenAi).toBe(
      true,
    );
    expect(resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: "co_caddington", channel: "chatgpt" }).reason).toBe(
      "chatgpt_stays_direct_tools",
    );

    const catalogue = buildTenantToolCatalogue({
      companyId: "co_caddington",
      connectors: ["conn_xero", "conn_google_drive", "conn_microsoft_365"],
      role: "director",
    });
    expect(catalogue.tools).toEqual(expect.arrayContaining(["xero_sales_summary", "list_documents", "search_company_knowledge"]));
    expect(catalogue.tools).not.toContain("outlook_list_messages");
    expect(tenantHasCapability({ connectors: ["conn_google_drive"], capability: "CATALOGUE_LIST" })).toBe(true);
    expect(resolveRequestPricingPolicy("co_caddington")).toBeNull();
  });
});

describe("HT capability isolation readiness", () => {
  it("loads only connected capabilities and never advertises EL systems", () => {
    const policy = resolveBrainPolicy({ env: SHADOW_ENV, companyId: "co_ht" });
    expect(policy.mode).toBe("cloudflare");
    expect(policy.useOpenAi).toBe(false);

    const empty = buildTenantToolCatalogue({ companyId: "co_ht", connectors: [], role: "director" });
    expect(empty.tools.some((name) => name.startsWith("xero_"))).toBe(false);
    expect(empty.tools.some((name) => name.startsWith("outlook_"))).toBe(false);
    expect(empty.capabilities).not.toContain("ACCOUNTING_SALES");
    expect(empty.capabilities).not.toContain("EMAIL_LIST");

    const knowledgeOnly = buildTenantToolCatalogue({
      companyId: "co_ht",
      connectors: ["conn_sharepoint"],
      role: "office_staff",
    });
    expect(knowledgeOnly.tools).toEqual(expect.arrayContaining(["search_company_knowledge", "list_documents"]));
    expect(knowledgeOnly.tools.some((name) => name.startsWith("xero_"))).toBe(false);

    const elEvidence = isolateEvidenceForCompany(
      {
        companyId: "co_el",
        recentEmail: {
          id: "el_1",
          subject: "EL only",
          from: "a@b.test",
          receivedDateTime: "2026-09-04T09:00:00Z",
          mailboxAddress: "info@elvex.test",
          body: "secret",
          toolName: "outlook_list_messages",
        },
      },
      "co_ht",
    );
    expect(elEvidence.recentEmail).toBeFalsy();
    expect(resolveRequestPricingPolicy("co_ht")).toBeNull();
  });
});
