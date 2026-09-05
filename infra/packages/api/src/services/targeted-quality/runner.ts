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

async function loadDirector(env: Env, companyId = TARGETED_COMPANY_ID) {
  if (companyId === TARGETED_COMPANY_ID) {
    const row = await env.DB.prepare(
      `SELECT u.id AS user_id
       FROM users u
       JOIN company_memberships m ON m.user_id = u.id
       WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active' AND m.role = 'director'
         AND lower(u.email) IN (?, ?)
       ORDER BY CASE lower(u.email) WHEN ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
      .bind(companyId, DIRECTOR_EMAILS[0], DIRECTOR_EMAILS[1], DIRECTOR_EMAILS[0])
      .first<{ user_id: string }>();
    if (row) return loadLiveCompanyActor(env.DB, row.user_id, companyId);
  }
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active'
       AND m.role IN ('director', 'company_admin', 'admin')
     ORDER BY CASE m.role WHEN 'director' THEN 0 WHEN 'company_admin' THEN 1 ELSE 2 END, u.email
     LIMIT 1`,
  )
    .bind(companyId)
    .first<{ user_id: string }>();
  if (!row) return null;
  return loadLiveCompanyActor(env.DB, row.user_id, companyId);
}

async function usageCharged(env: Env, interactionId: string, companyId = TARGETED_COMPANY_ID): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(customer_charge_cents), 0) AS cents
     FROM usage_records WHERE interaction_id = ? AND company_id = ?`,
  )
    .bind(interactionId, companyId)
    .first<{ cents: number }>();
  return Number(row?.cents ?? 0) > 0;
}

function proofFromPortal(result: Awaited<ReturnType<typeof sendPortalChatMessage>>) {
  const meta = result.assistantMessage.metadata;
  return {
    plannerProvider: meta.plannerProvider ?? null,
    synthesisProvider: meta.synthesisProvider ?? meta.provider ?? null,
    userVisibleBrain: meta.userVisibleBrain ?? null,
    brainMode: meta.brainMode ?? null,
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    estimatedCostUsd: meta.estimatedCostUsd ?? null,
  };
}

export async function runTargetedSlice(
  env: Env,
  input: { stage: string; ids?: string[]; companyId?: string },
): Promise<Record<string, unknown>> {
  const companyId = input.companyId || (input.stage === "caddington-openai-primary" ? "co_caddington" : TARGETED_COMPANY_ID);
  const questions = questionsForStage(input.stage, input.ids);
  const director = await loadDirector(env, companyId);
  if (!director?.active) throw new Error("Director actor unavailable");
  const sessionUser = liveActorToSessionUser(director);
  const connectors = await listConnectedConnectorIds(env, companyId);
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
          companyId,
          sessionUser,
          conversationId: portalByUser.get(`${sessionUser.userId}:${question.sequence ?? question.id}`),
          text: question.text,
          trafficClass: "TEST",
          userAgent: "InfraAcceptance/1.0",
          connectors,
        });
        portalByUser.set(`${sessionUser.userId}:${question.sequence ?? question.id}`, result.conversation.id);
        const tools = result.assistantMessage.metadata.toolNames ?? [];
        const scored = scoreTargetedTurn({
          question,
          tools,
          reply: result.assistantMessage.content,
          denied: Boolean(result.assistantMessage.metadata.permissionDenied),
          charged: await usageCharged(env, interactionId, companyId),
          latencyMs: Date.now() - started,
          terminal: String(result.assistantMessage.metadata.terminal ?? "success"),
        });
        turns.push(scored);
        raw.push({
          id: question.id,
          channel: question.channel,
          tools,
          reply: result.assistantMessage.content.slice(0, 360),
          conversationId: result.conversation.id,
          terminal: scored.terminal,
          defects: scored.defects,
          latencyMs: Date.now() - started,
          ...proofFromPortal(result),
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
      companyId,
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
      charged: await usageCharged(env, interactionId, companyId),
      latencyMs: Date.now() - started,
      terminal: String(answer.intelligence?.terminal ?? answer.outcome),
    });
    turns.push(scored);
    raw.push({
      id: question.id,
      channel: question.channel,
      tools,
      reply: answer.reply.slice(0, 360),
      defects: scored.defects,
      latencyMs: Date.now() - started,
      plannerProvider: answer.plannerProvider ?? answer.intelligence?.plannerProvider ?? null,
      synthesisProvider: answer.synthesisProvider ?? answer.intelligence?.synthesisProvider ?? null,
      userVisibleBrain: answer.userVisibleBrain ?? answer.intelligence?.userVisibleBrain ?? null,
      brainMode: answer.brainMode ?? answer.intelligence?.brainMode ?? null,
      provider: answer.intelligence?.provider ?? null,
      model: answer.intelligence?.model ?? null,
      estimatedCostUsd: answer.intelligence?.estimatedCostUsd ?? null,
      modelRounds: (answer.intelligence?.modelRounds ?? []).map((row) => ({
        provider: row.provider,
        model: row.model,
        latencyMs: row.latencyMs,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        estimatedCostUsd: row.estimatedCostUsd,
        fallbackUsed: row.fallbackUsed,
      })),
    });
  }

  return {
    stage: input.stage,
    companyId,
    asked: questions.map((row) => row.id),
    director: director.email,
    turns: raw,
    scores: turns,
  };
}
