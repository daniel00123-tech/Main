import { describe, expect, it } from "vitest";
import { questionsForStage, TARGETED_PRIMARY } from "./bank";
import { scoreTargetedTurn } from "./score";
import { classifyDailyTraffic } from "../daily-improvement/traffic";
import { classifyScope } from "../intelligence/scope.js";
import { detectRequestedCapabilities, wantsMultiCapabilityRead } from "../intelligence/company-tool-registry.js";
import { buildConversationState } from "../intelligence/state.js";
import { emailBodyRequired } from "../intelligence/evidence.js";

describe("targeted quality bank", () => {
  it("has at least 60 fresh prompts and no overnight IDs", () => {
    expect(TARGETED_PRIMARY.length).toBeGreaterThanOrEqual(60);
    expect(TARGETED_PRIMARY.some((row) => /^(WA|PC|MCP|FU|R1A)\d+/.test(row.id))).toBe(false);
    expect(questionsForStage("knowledge")).toHaveLength(10);
    expect(questionsForStage("mixed").length).toBeGreaterThanOrEqual(15);
    expect(questionsForStage("followup").length).toBeGreaterThanOrEqual(10);
  });
});

describe("targeted scoring honesty", () => {
  it("does not treat an honest knowledge no-result as a defect when search ran", () => {
    const scored = scoreTargetedTurn({
      question: TARGETED_PRIMARY.find((row) => row.id === "K10")!,
      tools: ["search_company_knowledge"],
      reply: "I searched company knowledge and could not find a purchase-order process document.",
      denied: false,
      charged: false,
      latencyMs: 800,
    });
    expect(scored.perfect).toBe(true);
    expect(scored.defects).not.toContain("KNOWLEDGE_RETRIEVAL_FAILURE");
  });

  it("penalises catalogue substitution on a mixed knowledge ask", () => {
    const scored = scoreTargetedTurn({
      question: TARGETED_PRIMARY.find((row) => row.id === "M01")!,
      tools: ["list_documents", "outlook_list_messages"],
      reply: "Here are the newest files and the latest email subject.",
      denied: false,
      charged: false,
      latencyMs: 900,
    });
    expect(scored.defects).toContain("KNOWLEDGE_VS_CATALOGUE");
  });
});

describe("targeted architectural gates", () => {
  it("keeps live customer classification when the wording matches a bench prompt", () => {
    expect(
      classifyDailyTraffic({
        trafficClass: "CUSTOMER_REQUEST",
        userId: "user_1",
        userAgent: "Mozilla/5.0",
        sourceClient: "whatsapp",
        userMessage: "What are our Xero sales this month?",
      }),
    ).toBe("CUSTOMER_REQUEST");
  });

  it("routes fresh corrections to the named tool family", () => {
    const afterXero = buildConversationState({
      userText: "What are live Xero sales this month?",
      lastAnswerTopic: "finance",
      currentBusinessSystem: "xero",
      lastSuccessfulTool: "xero_sales_summary",
    });
    expect(classifyScope("No, check the inbox instead.", afterXero).tool).toMatch(/^outlook_/);
    expect(classifyScope("Sorry, I meant the document.", afterXero).tool).toBe("search_company_knowledge");
  });

  it("keeps semantic knowledge on search_company_knowledge in mixed asks", () => {
    expect(detectRequestedCapabilities("What does the health and safety policy say, and what is the latest info email?")).toContain(
      "KNOWLEDGE_SEARCH",
    );
    expect(wantsMultiCapabilityRead("What does the health and safety policy say, and what is the latest info email?")).toBe(true);
    expect(emailBodyRequired("What are they asking?")).toBe(true);
    expect(emailBodyRequired("What is the latest email subject?")).toBe(false);
  });
});
