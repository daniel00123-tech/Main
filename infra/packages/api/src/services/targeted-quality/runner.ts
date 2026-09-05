import type { Env } from "../../env";
import { liveActorToSessionUser, loadLiveCompanyActor } from "../../auth/live-identity";
import { executeWhatsAppIntelligence } from "../whatsapp-intelligence";
import { emptyEntityMemory, type WhatsAppEntityMemory } from "../whatsapp-entities";
import { listConnectedConnectorIds } from "../whatsapp-capabilities";
import { PortalChatError, sendPortalChatMessage } from "../portal-chat";
import type { WhatsAppTurn } from "../whatsapp-context";
import { TARGETED_COMPANY_ID } from "./types";
import { questionsForStage } from "./bank";
import { scoreTargetedTurn } from "./score";
import type { OvernightTurnScore } from "../overnight-qa/types";

const DIRECTOR_EMAILS = ["ella@elvexpropertyservices.com", "william@elvexpropertyservices.com"];

async function loadDirector(env: Env) {
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active' AND m.role = 'director'
       AND lower(u.email) IN (?, ?)
     ORDER BY CASE lower(u.email) WHEN ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(TARGETED_COMPANY_ID, DIRECTOR_EMAILS[0], DIRECTOR_EMAILS[1], DIRECTOR_EMAILS[0])
    .first<{ user_id: string }>();
  if (!row) return null;
  return loadLiveCompanyActor(env.DB, row.user_id, TARGETED_COMPANY_ID);
}

async function usageCharged(env: Env, interactionId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(customer_charge_cents), 0) AS cents
     FROM usage_records WHERE interaction_id = ? AND company_id = ?`,
  )
    .bind(interactionId, TARGETED_COMPANY_ID)
    .first<{ cents: number }>();
  return Number(row?.cents ?? 0) > 0;
}

export async function runTargetedSlice(
  env: Env,
  input: { stage: string; ids?: string[] },
): Promise<Record<string, unknown>> {
  const questions = questionsForStage(input.stage, input.ids);
  const director = await loadDirector(env);
  if (!director?.active) throw new Error("Director actor unavailable");
  const sessionUser = liveActorToSessionUser(director);
  const connectors = await listConnectedConnectorIds(env, TARGETED_COMPANY_ID);
  const turns: OvernightTurnScore[] = [];
  const raw: Array<Record<string, unknown>> = [];
  let memory: WhatsAppEntityMemory = emptyEntityMemory();
  let prior: WhatsAppTurn[] = [];
  const portalByUser = new Map<string, string>();

  for (const question of questions) {
    const started = Date.now();
    const interactionId = `tqa_${question.id}_${Date.now()}`;
    const usePortal = question.channel === "portal" || question.channel === "followup";
    if (usePortal) {
      try {
        const result = await sendPortalChatMessage(env, {
          companyId: TARGETED_COMPANY_ID,
          sessionUser,
          conversationId: portalByUser.get(sessionUser.userId),
          text: question.text,
          trafficClass: "TEST",
          userAgent: "InfraAcceptance/1.0",
          connectors,
        });
        portalByUser.set(sessionUser.userId, result.conversation.id);
        const tools = result.assistantMessage.metadata.toolNames ?? [];
        const scored = scoreTargetedTurn({
          question,
          tools,
          reply: result.assistantMessage.content,
          denied: Boolean(result.assistantMessage.metadata.permissionDenied),
          charged: await usageCharged(env, interactionId),
          latencyMs: Date.now() - started,
          terminal: String(result.assistantMessage.metadata.terminal ?? "success"),
        });
        turns.push(scored);
        raw.push({
          id: question.id,
          tools,
          reply: result.assistantMessage.content.slice(0, 280),
          conversationId: result.conversation.id,
          terminal: scored.terminal,
          defects: scored.defects,
        });
      } catch (error) {
        const message = error instanceof PortalChatError ? error.message : String(error);
        const scored = scoreTargetedTurn({
          question,
          tools: [],
          reply: message,
          denied: false,
          charged: false,
          latencyMs: Date.now() - started,
          terminal: "failed",
        });
        turns.push(scored);
        raw.push({ id: question.id, tools: [], reply: message.slice(0, 280), harnessError: message, defects: scored.defects });
      }
      continue;
    }

    const answer = await executeWhatsAppIntelligence(env, {
      companyId: TARGETED_COMPANY_ID,
      sessionUser,
      originalText: question.text,
      memory,
      priorTurns: prior,
      interactionId,
      connectors,
      trafficClass: "TEST",
    });
    memory = answer.entities;
    prior = [...prior, { role: "user", text: question.text }, { role: "assistant", text: answer.reply }].slice(-8);
    const tools = (answer.intelligence?.toolCalls ?? []).map((call) => call.name);
    const scored = scoreTargetedTurn({
      question,
      tools,
      reply: answer.reply,
      denied: (answer.intelligence?.toolCalls ?? []).some((call) => /permission/i.test(String(call.error ?? ""))),
      charged: await usageCharged(env, interactionId),
      latencyMs: Date.now() - started,
      terminal: String(answer.intelligence?.terminal ?? answer.outcome),
    });
    turns.push(scored);
    raw.push({ id: question.id, tools, reply: answer.reply.slice(0, 280), defects: scored.defects });
  }

  return {
    stage: input.stage,
    asked: questions.map((row) => row.id),
    director: director.email,
    turns: raw,
    scores: turns,
  };
}
