/**
 * Gated EL Business WhatsApp 50-question campaign.
 * Uses executeWhatsAppIntelligence only. No outbound WhatsApp.
 */
import type { Env } from "../../env";
import { liveActorToSessionUser, loadLiveCompanyActor } from "../../auth/live-identity";
import { executeWhatsAppIntelligence } from "../whatsapp-intelligence";
import { emptyEntityMemory, type WhatsAppEntityMemory } from "../whatsapp-entities";
import { listConnectedConnectorIds } from "../whatsapp-capabilities";
import { classifyScope } from "../intelligence/scope.js";
import { buildConversationState } from "../intelligence/state.js";
import { isGenericRetryCopy } from "../intelligence/verbalise-business.js";
import {
  EL_BUSINESS_WHATSAPP_50_V1,
  SUITE_COMPANY_ID,
  SUITE_ID,
  type FrozenQuestion,
} from "./el-business-whatsapp-50-v1.js";
import { acceptanceGate, scoreTurn, tallyGrades, type ScoredTurn } from "./score.js";

const DIRECTOR_EMAILS = ["ella@elvexpropertyservices.com", "william@elvexpropertyservices.com"];
const OFFICE_EMAILS = ["sharon@elvexpropertyservices.com", "lauren@elvexpropertyservices.com"];

export type CampaignSlice = {
  ids?: string[];
  conversation?: FrozenQuestion["conversation"];
  memory?: WhatsAppEntityMemory;
  actor?: FrozenQuestion["actor"];
  simulateFailure?: boolean;
  texts?: Array<{ id: string; text: string; family?: FrozenQuestion["family"]; expectedToolPrefix?: string | null }>;
};

async function loadRoleActor(env: Env, role: "director" | "office_staff", emails: string[]) {
  const placeholders = emails.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, lower(u.email) AS email, m.role AS role
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ?
       AND m.status = 'active'
       AND u.status = 'active'
       AND m.role = ?
       AND lower(u.email) IN (${placeholders})
     ORDER BY CASE lower(u.email) WHEN ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(SUITE_COMPANY_ID, role, ...emails, emails[0])
    .first<{ user_id: string; email: string; role: string }>();
  if (!row) return null;
  const actor = await loadLiveCompanyActor(env.DB, row.user_id, SUITE_COMPANY_ID);
  return actor;
}

function questionsForSlice(slice: CampaignSlice): FrozenQuestion[] {
  if (slice.texts?.length) {
    return slice.texts.map((row) => ({
      id: row.id,
      section: "C",
      text: row.text,
      actor: slice.actor === "office_staff" ? "office_staff" : "director",
      conversation: "mixed",
      family: row.family ?? "knowledge",
      expectedToolPrefix: row.expectedToolPrefix ?? null,
      expectedDeny: false,
    }));
  }
  let rows = EL_BUSINESS_WHATSAPP_50_V1;
  if (slice.ids?.length) rows = rows.filter((row) => slice.ids!.includes(row.id));
  if (slice.conversation) rows = rows.filter((row) => row.conversation === slice.conversation);
  return rows;
}

export async function runElWhatsAppQaSlice(env: Env, slice: CampaignSlice = {}): Promise<Record<string, unknown>> {
  const questions = questionsForSlice(slice);
  const director = await loadRoleActor(env, "director", DIRECTOR_EMAILS);
  const office = await loadRoleActor(env, "office_staff", OFFICE_EMAILS);
  if (!director?.active || !office?.active) {
    return {
      suiteId: SUITE_ID,
      companyId: SUITE_COMPANY_ID,
      mode: "GATED",
      verdict: "GATED",
      error: "Missing active EL director or office_staff actor",
      director: director?.email ?? null,
      office: office?.email ?? null,
    };
  }

  const connectors = await listConnectedConnectorIds(env, SUITE_COMPANY_ID);
  let memory = slice.memory ?? emptyEntityMemory();
  const turns: ScoredTurn[] = [];
  const raw: Array<Record<string, unknown>> = [];

  for (const question of questions) {
    const actor = question.actor === "office_staff" ? office : director;
    if (question.actor === "office_staff" && slice.memory && slice.actor === "director") {
      memory = emptyEntityMemory();
    }
    const sessionUser = liveActorToSessionUser(actor);
    const interactionId = `elwa50_${SUITE_ID}_${question.id}_${Date.now()}`;
    const started = Date.now();
    const answer = await executeWhatsAppIntelligence(env, {
      companyId: SUITE_COMPANY_ID,
      sessionUser,
      originalText: question.text,
      memory,
      priorTurns: [],
      interactionId,
      connectors,
      trafficClass: "TEST",
    });
    memory = answer.entities;
    const tools = (answer.intelligence?.toolCalls ?? []).map((call) => call.name);
    const usage = await env.DB.prepare(
      `SELECT action, tool_name, settlement_status, customer_charge_cents, source_client, success
       FROM usage_records
       WHERE interaction_id = ? AND company_id = ?
       ORDER BY recorded_at DESC LIMIT 5`,
    )
      .bind(interactionId, SUITE_COMPANY_ID)
      .all<{
        action: string | null;
        tool_name: string | null;
        settlement_status: string | null;
        customer_charge_cents: number | null;
        source_client: string | null;
        success: number | null;
      }>();
    const usageRow = usage.results?.[0] ?? null;
    const scored = scoreTurn({
      question,
      role: actor.role,
      reply: answer.reply,
      tools,
      scope: answer.intelligence?.scope ?? null,
      latencyMs: Date.now() - started,
      settlement: usageRow?.settlement_status ?? null,
      usageAction: usageRow?.action ?? usageRow?.tool_name ?? null,
      charged: Number(usageRow?.customer_charge_cents ?? 0) > 0,
      arguments: (answer.intelligence?.toolCalls ?? []).map((call) => call.name ? {} : {}),
      toolOk: (answer.intelligence?.toolCalls ?? []).map((call) => call.ok),
    });
    turns.push(scored);
    raw.push({
      id: question.id,
      role: actor.role,
      email: actor.email,
      reply: answer.reply.slice(0, 360),
      tools,
      scope: answer.intelligence?.scope ?? null,
      genericRetry: isGenericRetryCopy(answer.reply),
      usage: usageRow,
      sourceClient: usageRow?.source_client ?? "whatsapp",
      grade: scored.grade,
      categories: scored.categories,
    });
  }

  const gate = acceptanceGate(turns);
  return {
    suiteId: SUITE_ID,
    companyId: SUITE_COMPANY_ID,
    mode: "GATED",
    director: { email: director.email, role: director.role },
    office: { email: office.email, role: office.role },
    connectors,
    asked: questions.map((row) => row.id),
    tallies: tallyGrades(turns),
    gate,
    memory,
    turns: raw,
  };
}

export function classifyFrozenSuite(): Array<{ id: string; scope: string; tool: string | null }> {
  return EL_BUSINESS_WHATSAPP_50_V1.map((question) => {
    const prior =
      question.section === "D"
        ? buildConversationState({
            userText: question.text,
            lastAnswerTopic: "finance",
            currentScope: "BUSINESS_SYSTEM",
            currentBusinessSystem: "xero",
            lastSuccessfulTool: "xero_sales_summary",
            lastAnswerText: "Xero sales from 2026-09-01 to 2026-09-04 are £5,094 across 32 invoices.",
          })
        : question.id === "C7"
          ? buildConversationState({
              userText: question.text,
              lastAnswerTopic: "finance",
              currentScope: "BUSINESS_SYSTEM",
              currentBusinessSystem: "xero",
              lastSuccessfulTool: "xero_sales_summary",
              userCorrection: true,
            })
          : question.id === "C8"
            ? buildConversationState({
                userText: question.text,
                lastAnswerTopic: "email",
                currentScope: "BUSINESS_SYSTEM",
                currentBusinessSystem: "email",
                lastSuccessfulTool: "outlook_list_messages",
                userCorrection: true,
              })
            : buildConversationState({ userText: question.text });
    const decision = classifyScope(question.text, prior);
    return { id: question.id, scope: decision.scope, tool: decision.tool };
  });
}
