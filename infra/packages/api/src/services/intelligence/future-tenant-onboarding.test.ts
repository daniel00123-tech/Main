import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBrainPolicy } from "./brain-policy.js";
import { buildTenantToolCatalogue } from "./company-tool-registry.js";
import { classifyTurnComplexity } from "./complexity-router.js";
import { isolateEvidenceForCompany } from "./tenant-isolation.js";
import { runResponseQualityGuard } from "./response-guard.js";
import { classifyTurnFailures } from "./failure-telemetry.js";
import { resolveRequestPricingPolicy } from "../customer-request-pricing.js";
import { classifyElTraffic, shouldChargeElCustomerRequest } from "../el-customer-billing.js";

const FUTURE = "co_newco";

describe("future tenant onboarding contract", () => {
  it("requires only configuration, not a forked reasoning engine", () => {
    const env = {
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_shadow",
      OPENAI_BRAIN_COMPANY_IDS: "co_el",
    };
    const policy = resolveBrainPolicy({ env, companyId: FUTURE });
    expect(policy.mode).toBe("cloudflare");
    expect(policy.useOpenAi).toBe(false);

    const catalogue = buildTenantToolCatalogue({
      companyId: FUTURE,
      connectors: ["conn_xero"],
      role: "director",
    });
    expect(catalogue.tools).toContain("xero_sales_summary");
    expect(catalogue.tools).not.toContain("outlook_list_messages");

    expect(classifyTurnComplexity({ userText: "What are Xero sales this month?", hasFreshBusinessQuestion: true })).toBe(
      "standard_planning",
    );
    expect(isolateEvidenceForCompany({ companyId: "co_el", recentXero: { toolName: "xero_sales_summary", total: 1, count: 1, fromDate: null, toDate: null, currency: "GBP", summary: "x", label: "x" } }, FUTURE).recentXero).toBeFalsy();
    expect(runResponseQualityGuard).toBeTypeOf("function");
    expect(classifyTurnFailures).toBeTypeOf("function");
    expect(resolveRequestPricingPolicy(FUTURE)).toBeNull();
    expect(shouldChargeElCustomerRequest(FUTURE, classifyElTraffic({ sourceClient: "portal_chat" }))).toBe(false);
  });

  it("documents the company MCP standard", () => {
    const path = resolve(process.cwd(), "../../../docs/INFRA-COMPANY-MCP-STANDARD.md");
    const fallback = resolve(process.cwd(), "../../docs/INFRA-COMPANY-MCP-STANDARD.md");
    const file = existsSync(path) ? path : fallback;
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    for (const heading of [
      "Authentication contract",
      "Company binding",
      "Health contract",
      "Capability registry",
      "Tool schemas",
      "Permission mapping",
      "Connector health",
      "Response normalisation",
      "Evidence metadata",
      "Usage / billing metadata",
      "Failure semantics",
      "OpenAI reasoning compatibility",
      "Test requirements",
      "Deployment requirements",
    ]) {
      expect(body).toContain(heading);
    }
  });

  it("can promote the future tenant later through policy only", () => {
    const promoted = resolveBrainPolicy({
      env: {
        OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
        OPENAI_BRAIN_ENABLED: "true",
        OPENAI_BRAIN_MODE: "openai_shadow",
        OPENAI_BRAIN_COMPANY_IDS: "co_el,co_newco",
        OPENAI_BRAIN_COMPANY_MODES: "co_newco=openai_shadow",
      },
      companyId: FUTURE,
    });
    expect(promoted.mode).toBe("openai_shadow");
    expect(promoted.useOpenAi).toBe(false);
    expect(promoted.shadow).toBe(true);
  });
});
