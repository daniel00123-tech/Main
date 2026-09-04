import { describe, expect, it } from "vitest";
import { elvexCan } from "@infra/shared";
import { classifyScope } from "./intelligence/scope";
import { buildConversationState } from "./intelligence/state";
import { ROUND1_CASES, ROUND2_CASES, type CampaignCase } from "./el-business-campaign-cases";

function toolFamily(tool: string | null, scope: string): CampaignCase["expectedToolFamily"] | "other" {
  if (scope === "CONTROLLED_ACTION") return "controlled";
  if (scope === "GENERAL_CONVERSATION") return "conversation";
  if (scope === "CONNECTOR_CAPABILITY") return "capability";
  if (scope === "SYSTEM_META") return "system_meta";
  if (tool === "list_documents") return "catalogue";
  if (tool?.startsWith("xero_")) return "xero";
  if (tool?.startsWith("outlook_")) return "outlook";
  if (tool?.includes("knowledge") || tool === "search_company_knowledge" || tool === "get_knowledge_document" || tool === "search_document") {
    return "knowledge";
  }
  return "other";
}

function scoreCase(testCase: CampaignCase, prior?: CampaignCase) {
  const state = buildConversationState({
    userText: prior?.prompt ?? testCase.prompt,
    lastAnswerTopic:
      prior?.expectedToolFamily === "xero"
        ? "finance"
        : prior?.expectedToolFamily === "outlook"
          ? "email"
          : prior?.expectedToolFamily === "knowledge" || prior?.expectedToolFamily === "catalogue"
            ? "company_knowledge"
            : null,
    currentScope: prior?.expectedScope as never,
    currentBusinessSystem: prior?.expectedToolFamily === "xero" ? "xero" : prior?.expectedToolFamily === "outlook" ? "outlook" : null,
    lastSuccessfulTool: prior?.expectedTool ?? null,
    userCorrection: /meant|instead|forget that|sorry/i.test(testCase.prompt),
    connectors: ["conn_xero", "conn_outlook_shared", "conn_sharepoint", "conn_onedrive"],
  });
  const decision = classifyScope(testCase.prompt, state);
  const family = toolFamily(decision.tool, decision.scope);
  const role = testCase.role ?? "director";
  const allowed = elvexCan(role, testCase.expectedCapability as never);
  const rbacOk = testCase.expectDenied ? !allowed : allowed || testCase.expectedCapability === "system.health";
  const scopeOk = decision.scope === testCase.expectedScope;
  const familyOk = family === testCase.expectedToolFamily;
  const toolOk = !testCase.expectedTool || decision.tool === testCase.expectedTool;
  return { decision, family, rbacOk, scopeOk, familyOk, toolOk, allowed };
}

function runSuite(cases: CampaignCase[], priorPool: CampaignCase[] = cases) {
  const byId = new Map(priorPool.map((item) => [item.id, item]));
  const failures: string[] = [];
  let hits = 0;
  for (const testCase of cases) {
    const prior = testCase.priorIds?.[0] ? byId.get(testCase.priorIds[0]) : undefined;
    const result = scoreCase(testCase, prior);
    if (result.scopeOk && result.familyOk && result.toolOk && result.rbacOk) hits += 1;
    else {
      failures.push(
        `${testCase.id} "${testCase.prompt}" expected ${testCase.expectedScope}/${testCase.expectedToolFamily}/${testCase.expectedTool ?? "*"} got ${result.decision.scope}/${result.family}/${result.decision.tool} rbac=${result.rbacOk}`,
      );
    }
  }
  return { hits, total: cases.length, failures };
}

describe("EL Business frozen campaign — shared routing/RBAC", () => {
  it("scores Round 1 core + RBAC without live connectors", () => {
    const { hits, total, failures } = runSuite(ROUND1_CASES);
    if (hits < total) {
      throw new Error(`Round 1 routing ${hits}/${total}\n${failures.join("\n")}`);
    }
    expect(hits).toBe(total);
  });

  it("denies office_staff Xero and finance mailbox, allows info", () => {
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("office_staff", "mail.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "mail.info.read")).toBe(true);
    expect(elvexCan("finance_team", "xero.sales.read")).toBe(true);
    expect(elvexCan("director", "xero.sales.read")).toBe(true);
  });

  it("scores Round 2 adversarial routing", () => {
    const { hits, total, failures } = runSuite(ROUND2_CASES, [...ROUND1_CASES, ...ROUND2_CASES]);
    if (hits < total) {
      throw new Error(`Round 2 routing ${hits}/${total}\n${failures.join("\n")}`);
    }
    expect(hits).toBe(total);
  });
});
