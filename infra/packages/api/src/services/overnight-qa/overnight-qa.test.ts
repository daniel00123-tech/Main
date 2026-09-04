import { describe, expect, it } from "vitest";
import { classifyElTraffic, shouldChargeElCustomerRequest } from "../el-customer-billing";
import { classifyQueryFreshness, expectedAccountingSource } from "../warehouse/freshness";
import { detectRequestedCapabilities } from "../intelligence/company-tool-registry";
import { BUSINESS_GATEWAY_TOOL_SET, isAllowedBusinessGatewayTool } from "../intelligence/business-gateway-tools";
import { WAREHOUSE_TOOL_NAMES } from "../warehouse/standard";
import { OVERNIGHT_PRIMARY, OVERNIGHT_ALL, FRESH_RETEST_SETS, questionsForStage } from "./bank";
import { scoreOvernightTurn, scoreChannel } from "./score";

const NOW = new Date("2026-09-04T12:00:00.000Z");

describe("overnight QA frozen bank", () => {
  it("has at least 80 unique primary turns", () => {
    const ids = OVERNIGHT_PRIMARY.map((row) => row.id);
    expect(ids.length).toBeGreaterThanOrEqual(80);
    expect(new Set(ids).size).toBe(ids.length);
    expect(questionsForStage("whatsapp").length).toBe(20);
    expect(questionsForStage("portal").length).toBe(20);
    expect(questionsForStage("mcp").length).toBe(20);
    expect(questionsForStage("warehouse").length).toBe(10);
    expect(questionsForStage("followup").length).toBe(10);
    expect(OVERNIGHT_ALL.length).toBeGreaterThan(OVERNIGHT_PRIMARY.length);
  });

  it("does not reuse the first fresh retest prompts", () => {
    const frozen = new Set(OVERNIGHT_PRIMARY.map((row) => row.text.toLowerCase()));
    for (const question of FRESH_RETEST_SETS[0] ?? []) {
      expect(frozen.has(question.text.toLowerCase())).toBe(false);
    }
  });
});

describe("TEST traffic isolation", () => {
  it("keeps explicit TEST and acceptance user-agents off the EL 3p tariff", () => {
    expect(classifyElTraffic({ sourceClient: "portal_chat", trafficClass: "TEST" })).toBe("TEST");
    expect(classifyElTraffic({ sourceClient: "whatsapp", trafficClass: "TEST" })).toBe("TEST");
    expect(classifyElTraffic({ sourceClient: "chatgpt", userAgent: "InfraAcceptance/1.0" })).toBe("TEST");
    expect(shouldChargeElCustomerRequest("co_el", "TEST")).toBe(false);
    expect(shouldChargeElCustomerRequest("co_el", "CUSTOMER_REQUEST")).toBe(true);
    expect(classifyElTraffic({ sourceClient: "portal_chat" })).toBe("CUSTOMER_REQUEST");
  });
});

describe("warehouse vs live routing concepts", () => {
  it("classifies named completed months and last-month windows as historical", () => {
    expect(classifyQueryFreshness("What were sales in March?", NOW)).toBe("HISTORICAL_ANALYTICAL");
    expect(classifyQueryFreshness("What were April sales?", NOW)).toBe("HISTORICAL_ANALYTICAL");
    expect(classifyQueryFreshness("What were May sales?", NOW)).toBe("HISTORICAL_ANALYTICAL");
    expect(classifyQueryFreshness("What did last month's invoiced sales come to?", NOW)).toBe("HISTORICAL_ANALYTICAL");
    expect(classifyQueryFreshness("Summarise sales for the last 3 completed months.", NOW)).toBe("HISTORICAL_ANALYTICAL");
    expect(classifyQueryFreshness("Give me a month-over-month sales comparison", NOW)).toBe("HISTORICAL_ANALYTICAL");
    expect(expectedAccountingSource("How many invoices did we raise in April?", NOW)).toBe("xero_warehouse");
  });

  it("keeps right-now and named-invoice questions on live Xero", () => {
    expect(classifyQueryFreshness("What are sales right now?", NOW)).toBe("CURRENT_LIVE_STATE");
    expect(classifyQueryFreshness("Has INV-02268 been paid?", NOW)).toBe("CURRENT_LIVE_STATE");
    expect(classifyQueryFreshness("What are overdue invoices right now?", NOW)).toBe("CURRENT_LIVE_STATE");
    expect(expectedAccountingSource("What are sales right now?", NOW)).toBe("xero_live");
    expect(detectRequestedCapabilities("What were sales in March?")).toContain("ACCOUNTING_WAREHOUSE");
    expect(detectRequestedCapabilities("What are sales right now?")).not.toContain("ACCOUNTING_WAREHOUSE");
  });

  it("allows warehouse tools on the shared WhatsApp/Portal gateway allow-list", () => {
    for (const name of WAREHOUSE_TOOL_NAMES) {
      expect(isAllowedBusinessGatewayTool(name)).toBe(true);
      expect(BUSINESS_GATEWAY_TOOL_SET.has(name)).toBe(true);
    }
    expect(isAllowedBusinessGatewayTool("xero_create_invoice")).toBe(false);
  });
});

describe("overnight scoring", () => {
  it("treats expected denials as success and test charges as defects", () => {
    const denied = scoreOvernightTurn({
      question: {
        id: "PC20",
        channel: "portal",
        text: "Tell me our Xero sales this month.",
        actor: "office_staff",
        family: "rbac",
        expectedToolPrefix: "xero_",
        expectedSource: "xero_live",
        expectedDeny: true,
      },
      tools: ["xero_sales_summary"],
      reply: "Your current permissions don’t allow this action.",
      denied: true,
      charged: false,
      latencyMs: 800,
    });
    expect(denied.perfect).toBe(true);
    expect(denied.rbacOk).toBe(true);

    const charged = scoreOvernightTurn({
      question: {
        id: "WA01",
        channel: "whatsapp",
        text: "How much have we taken in sales so far this month?",
        actor: "director",
        family: "xero_live",
        expectedToolPrefix: "xero_",
        expectedSource: "xero_live",
        expectedDeny: false,
      },
      tools: ["xero_sales_summary"],
      reply: "Sales this month are £5,094.",
      denied: false,
      charged: true,
      latencyMs: 900,
    });
    expect(charged.perfect).toBe(false);
    expect(charged.defects).toContain("TEST_TRAFFIC_CHARGED");
    expect(scoreChannel("whatsapp", [denied, charged]).score).toBeLessThan(10);
  });
});
