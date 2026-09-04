/**
 * Live EL Business campaign sections. Read-only. Never prints secrets.
 */

import { elvexCan } from "@infra/shared";
import type { Env } from "../env";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
import { sendPortalChatMessage } from "./portal-chat";
import { ROUND1_CASES, ROUND2_CASES, type CampaignCase } from "./el-business-campaign-cases";

const WILLIAM = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const SHARON = "user_949bcd80-e74e-449a-a280-da475fe18ace";
const MICHAEL = "user_e911ee26-9b4f-4e7c-a6f0-98f255f905e7";

export const CAMPAIGN_SUITES = [
  "r1_xero",
  "r1_outlook",
  "r1_knowledge",
  "r1_infra",
  "r1_rbac",
  "r2_xero",
  "r2_outlook",
  "r2_knowledge",
  "r2_infra",
] as const;
export type CampaignSuite = (typeof CAMPAIGN_SUITES)[number];

export function isCampaignSuite(value: string): value is CampaignSuite {
  return (CAMPAIGN_SUITES as readonly string[]).includes(value);
}

function clip(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function invented(text: string): boolean {
  return /as an example|hypothetical|i imagine|typical company might/i.test(text);
}

function scoreLive(testCase: CampaignCase, turn: {
  tools: string[];
  successfulTools: string[];
  permissionDenied: boolean;
  reply: string;
  hollowRetry: boolean;
  duplicateSuccessfulCalls: number;
  leaksAmount: boolean;
  scope?: string;
}): { score: number; category: string } {
  let score = 0;
  const family = testCase.expectedToolFamily;
  const usedXero = turn.tools.some((name) => name.startsWith("xero_"));
  const usedOutlook = turn.tools.some((name) => name.startsWith("outlook_"));
  const usedKnowledge = turn.tools.some((name) => /knowledge|list_documents|search_document/.test(name));
  if (family === "xero") score += usedXero ? 20 : 0;
  else if (family === "outlook") score += usedOutlook && !usedXero ? 20 : usedOutlook ? 10 : 0;
  else if (family === "knowledge" || family === "catalogue") score += usedKnowledge && !usedXero ? 20 : 0;
  else score += 20;
  if (testCase.expectDenied) score += turn.permissionDenied && !turn.leaksAmount ? 30 : 0;
  else score += turn.permissionDenied ? 0 : 20;
  score += invented(turn.reply) ? 0 : 15;
  score += turn.hollowRetry ? 0 : 15;
  score += turn.duplicateSuccessfulCalls === 0 ? 10 : 0;
  if (!testCase.expectDenied && family === "xero") {
    score += /£\s?[\d,]|0(\.00)?|no (invoices?|results)|could not find/i.test(turn.reply) ? 10 : 0;
  } else {
    score += turn.reply.trim().length > 12 ? 10 : 0;
  }
  const category = score >= 95 ? "EXCELLENT" : score >= 85 ? "GOOD" : score >= 75 ? "ACCEPTABLE" : score >= 50 ? "POOR" : "FAIL";
  return { score, category };
}

async function actorFor(env: Env, testCase: CampaignCase) {
  const id = testCase.role === "office_staff" ? SHARON : testCase.role === "finance_team" ? MICHAEL : WILLIAM;
  const loaded = await loadLiveCompanyActor(env.DB, id, "co_el");
  if (loaded?.active) return loaded;
  return loadLiveCompanyActor(env.DB, WILLIAM, "co_el");
}

function casesForSuite(suite: CampaignSuite): CampaignCase[] {
  if (suite === "r1_xero") return ROUND1_CASES.filter((item) => item.family === "xero");
  if (suite === "r1_outlook") return ROUND1_CASES.filter((item) => item.family === "outlook");
  if (suite === "r1_knowledge") return ROUND1_CASES.filter((item) => item.family === "knowledge");
  if (suite === "r1_infra") return ROUND1_CASES.filter((item) => item.family === "infra");
  if (suite === "r1_rbac") return ROUND1_CASES.filter((item) => item.family === "rbac");
  if (suite === "r2_xero") return ROUND2_CASES.filter((item) => item.family === "xero");
  if (suite === "r2_outlook") return ROUND2_CASES.filter((item) => item.family === "outlook");
  if (suite === "r2_knowledge") return ROUND2_CASES.filter((item) => item.family === "knowledge");
  return ROUND2_CASES.filter((item) => item.family === "infra").slice(0, 10);
}

export async function runElBusinessCampaignSuite(env: Env, suite: CampaignSuite): Promise<Record<string, unknown>> {
  const cases = casesForSuite(suite);
  const results: Array<Record<string, unknown>> = [];
  const conversations = new Map<string, string>();
  const started = Date.now();

  for (const testCase of cases) {
    const actor = await actorFor(env, testCase);
    if (!actor?.active) {
      results.push({ id: testCase.id, result: "SKIP", reason: "actor_missing" });
      continue;
    }
    const sessionUser = liveActorToSessionUser(actor);
    const priorId = testCase.priorIds?.find((id) => conversations.has(id));
    const conversationId = priorId ? conversations.get(priorId) : undefined;
    const turnStarted = Date.now();
    const turn = await sendPortalChatMessage(env, {
      companyId: "co_el",
      sessionUser,
      conversationId,
      text: testCase.prompt,
    });
    const content = turn.assistantMessage.content;
    const tools = turn.assistantMessage.metadata.toolNames ?? [];
    const row = {
      tools,
      successfulTools: turn.assistantMessage.metadata.successfulTools ?? [],
      permissionDenied: Boolean(turn.assistantMessage.metadata.permissionDenied),
      reply: content,
      hollowRetry: /I need another moment to finish that/i.test(content),
      duplicateSuccessfulCalls: turn.assistantMessage.metadata.duplicateSuccessfulCalls ?? 0,
      leaksAmount: /£\s?[\d,]/.test(content) && Boolean(turn.assistantMessage.metadata.permissionDenied),
      scope: turn.assistantMessage.metadata.scope,
    };
    const scored = scoreLive(testCase, row);
    conversations.set(testCase.id, turn.conversation.id);
    results.push({
      id: testCase.id,
      channel: "portal_chat",
      user: actor.email,
      role: actor.role,
      prompt: testCase.prompt,
      expectedCapability: testCase.expectedCapability,
      actualScope: row.scope,
      actualTool: tools[0] ?? null,
      tools,
      permissionDenied: row.permissionDenied,
      rbacAllowed: elvexCan(actor.role, testCase.expectedCapability as never),
      answer: clip(content),
      latencyMs: Date.now() - turnStarted,
      toolCallCount: tools.length,
      duplicateSuccessfulCalls: row.duplicateSuccessfulCalls,
      score: scored.score,
      category: scored.category,
      hollowRetry: row.hollowRetry,
    });
  }

  const scores = results.map((row) => Number(row.score ?? 0));
  const average = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0;
  return {
    suite,
    companyId: "co_el",
    turnCount: results.length,
    average,
    latencyMs: Date.now() - started,
    results,
  };
}
