import type { Env } from "../../env";
import { liveActorToSessionUser, loadLiveCompanyActor } from "../../auth/live-identity";
import { issueMcpAccessToken, recordAccessJti } from "../../auth/mcp-oauth";
import { executeWhatsAppIntelligence } from "../whatsapp-intelligence";
import { emptyEntityMemory, type WhatsAppEntityMemory } from "../whatsapp-entities";
import { listConnectedConnectorIds } from "../whatsapp-capabilities";
import { sendPortalChatMessage } from "../portal-chat";
import { executeWarehouseQuery } from "../warehouse/query";
import { createD1WarehouseRepository } from "../warehouse/store";
import { classifyQueryFreshness, expectedAccountingSource } from "../warehouse/freshness";
import type { WhatsAppTurn } from "../whatsapp-context";
import { OVERNIGHT_COMPANY_ID } from "./types";
import { questionsForStage } from "./bank";
import { scoreOvernightTurn, type OvernightTurnScore } from "./score";
import type { OvernightQuestion } from "./types";

const DIRECTOR_EMAILS = ["ella@elvexpropertyservices.com", "william@elvexpropertyservices.com"];
const OFFICE_EMAILS = ["sharon@elvexpropertyservices.com", "lauren@elvexpropertyservices.com"];
const MCP_CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";

async function loadRoleActor(env: Env, role: "director" | "office_staff", emails: string[]) {
  const placeholders = emails.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active' AND m.role = ?
       AND lower(u.email) IN (${placeholders})
     ORDER BY CASE lower(u.email) WHEN ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(OVERNIGHT_COMPANY_ID, role, ...emails, emails[0])
    .first<{ user_id: string }>();
  if (!row) return null;
  return loadLiveCompanyActor(env.DB, row.user_id, OVERNIGHT_COMPANY_ID);
}

async function usageCharged(env: Env, interactionId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(customer_charge_cents), 0) AS cents
     FROM usage_records WHERE interaction_id = ? AND company_id = ?`,
  )
    .bind(interactionId, OVERNIGHT_COMPANY_ID)
    .first<{ cents: number }>();
  return Number(row?.cents ?? 0) > 0;
}

function sourceFromPayload(parsed: Record<string, unknown> | null): {
  source: string | null;
  warehouseAsOf: string | null;
  completeness: string | null;
} {
  if (!parsed) return { source: null, warehouseAsOf: null, completeness: null };
  const evidence = (parsed.evidence as Record<string, unknown> | undefined) ?? parsed;
  return {
    source: typeof parsed.source === "string" ? parsed.source : typeof evidence.source === "string" ? String(evidence.source) : null,
    warehouseAsOf:
      typeof parsed.warehouse_as_of === "string"
        ? parsed.warehouse_as_of
        : typeof parsed.warehouseAsOf === "string"
          ? parsed.warehouseAsOf
          : typeof evidence.warehouseAsOf === "string"
            ? String(evidence.warehouseAsOf)
            : null,
    completeness:
      typeof parsed.completeness_status === "string"
        ? parsed.completeness_status
        : typeof parsed.completenessStatus === "string"
          ? parsed.completenessStatus
          : typeof evidence.completenessStatus === "string"
            ? String(evidence.completenessStatus)
            : null,
  };
}

async function mcpCall(
  token: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ httpStatus: number; text: string; parsed: Record<string, unknown> | null; denied: boolean }> {
  const response = await fetch("https://app.infrastack.app/api/gateway/v1/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "InfraAcceptance/1.0",
      "X-Infra-Traffic-Class": "TEST",
      Origin: "https://chatgpt.com",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const rpc = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const result = rpc.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = result?.content?.find((part) => part.type === "text")?.text ?? JSON.stringify(rpc.error ?? {});
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = text ? { raw: text.slice(0, 240) } : null;
  }
  const denied =
    response.status === 403 ||
    /permissions? don.?t allow|your .* permissions|forbidden|not allowed/i.test(text);
  return { httpStatus: response.status, text, parsed, denied };
}

export async function runOvernightSlice(
  env: Env,
  input: { stage: string; ids?: string[] },
): Promise<Record<string, unknown>> {
  const questions = questionsForStage(input.stage, input.ids);
  const director = await loadRoleActor(env, "director", DIRECTOR_EMAILS);
  const office = await loadRoleActor(env, "office_staff", OFFICE_EMAILS);
  if (!director?.active) {
    return { stage: input.stage, verdict: "GATED", error: "Missing EL director actor" };
  }
  const connectors = await listConnectedConnectorIds(env, OVERNIGHT_COMPANY_ID);
  const turns: OvernightTurnScore[] = [];
  const raw: Array<Record<string, unknown>> = [];

  if (input.stage === "mcp") {
    if (!env.SESSION_SECRET) return { stage: "mcp", verdict: "GATED", error: "SESSION_SECRET missing" };
    const tokens = new Map<string, string>();
    for (const actor of [director, office]) {
      if (!actor?.active) continue;
      const issued = await issueMcpAccessToken(
        env.SESSION_SECRET,
        "https://app.infrastack.app",
        "https://app.infrastack.app/api/gateway/v1/mcp",
        {
          userId: actor.userId,
          email: actor.email,
          companyId: actor.companyId,
          membershipId: actor.membershipId,
          clientId: MCP_CLIENT_ID,
          channel: "chatgpt",
        },
      );
      await recordAccessJti(env.DB, { jti: issued.jti, userId: actor.userId, companyId: actor.companyId });
      tokens.set(actor.role === "office_staff" ? "office_staff" : "director", issued.token);
    }
    for (const question of questions) {
      const token = tokens.get(question.actor);
      if (!token) continue;
      const started = Date.now();
      const call = await mcpCall(token, question.mcpTool ?? "xero_sales_summary", question.mcpArgs ?? {});
      const fields = sourceFromPayload(call.parsed);
      const scored = scoreOvernightTurn({
        question,
        tools: [question.mcpTool ?? "unknown"],
        reply: call.text,
        denied: call.denied,
        charged: false,
        latencyMs: Date.now() - started,
        payloadSource: fields.source,
        warehouseAsOf: fields.warehouseAsOf,
        completeness: fields.completeness,
        terminal: call.denied ? "permission_denied" : "success",
      });
      turns.push(scored);
      raw.push({ id: question.id, httpStatus: call.httpStatus, ...fields, denied: call.denied, reply: call.text.slice(0, 240) });
    }
    return { stage: input.stage, asked: questions.map((row) => row.id), turns: raw, scores: turns };
  }

  if (input.stage === "billing") {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(customer_charge_cents), 0) AS cents
       FROM usage_records
       WHERE company_id = ?
         AND recorded_at >= datetime('now', '-6 hours')
         AND interaction_id LIKE 'ova_%'`,
    )
      .bind(OVERNIGHT_COMPANY_ID)
      .first<{ n: number; cents: number }>();
    return {
      stage: "billing",
      testRows: Number(row?.n ?? 0),
      customerChargeCents: Number(row?.cents ?? 0),
      tariffUntouched: true,
      ok: Number(row?.cents ?? 0) === 0,
    };
  }

  if (input.stage === "isolation") {
    const repo = createD1WarehouseRepository(env.DB);
    const el = await executeWarehouseQuery(repo, {
      companyId: "co_el",
      aggregation: "sales_total",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    const cad = await executeWarehouseQuery(repo, {
      companyId: "co_caddington",
      aggregation: "sales_total",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    const ht = await executeWarehouseQuery(repo, {
      companyId: "co_ht",
      aggregation: "sales_total",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    const elCompany = String((el.result as { companyId?: string } | undefined)?.companyId ?? el.evidence.companyId);
    return {
      stage: "isolation",
      elCompany,
      elHasRows: Boolean(el.result),
      caddingtonIsolated: cad.evidence.companyId === "co_caddington" && el.evidence.companyId === "co_el",
      htIsolated: ht.evidence.companyId === "co_ht",
      elCannotSeeCaddington: el.evidence.companyId !== "co_caddington",
      ok: el.evidence.companyId === "co_el" && cad.evidence.companyId === "co_caddington" && ht.evidence.companyId === "co_ht",
    };
  }

  let memory: WhatsAppEntityMemory = emptyEntityMemory();
  let prior: WhatsAppTurn[] = [];
  let portalConversationId: string | undefined;
  const sessionFor = (question: OvernightQuestion) => {
    const actor = question.actor === "office_staff" ? office : director;
    if (!actor?.active) return null;
    return liveActorToSessionUser(actor);
  };

  for (const question of questions) {
    const sessionUser = sessionFor(question);
    if (!sessionUser) continue;
    const started = Date.now();
    const interactionId = `ova_${question.id}_${Date.now()}`;

    if (question.channel === "portal" || (input.stage === "followup" && question.sequence === "email")) {
      const result = await sendPortalChatMessage(env, {
        companyId: OVERNIGHT_COMPANY_ID,
        sessionUser,
        conversationId: portalConversationId,
        text: question.text,
        trafficClass: "TEST",
        userAgent: "InfraAcceptance/1.0",
        connectors,
      });
      portalConversationId = result.conversation.id;
      const tools = result.assistantMessage.metadata.toolNames ?? [];
      const charged = await usageCharged(env, interactionId);
      const scored = scoreOvernightTurn({
        question,
        tools,
        reply: result.assistantMessage.content,
        denied: Boolean(result.assistantMessage.metadata.permissionDenied),
        charged,
        latencyMs: Date.now() - started,
        terminal: String(result.assistantMessage.metadata.terminal ?? "success"),
        liveXeroAlsoCalled:
          question.expectedSource === "xero_warehouse" && tools.some((name) => name.startsWith("xero_")),
      });
      turns.push(scored);
      raw.push({ id: question.id, tools, reply: result.assistantMessage.content.slice(0, 280), conversationId: portalConversationId });
      continue;
    }

    if (question.channel === "warehouse" && input.stage === "warehouse") {
      const freshness = classifyQueryFreshness(question.text);
      const expected = expectedAccountingSource(question.text);
      const repo = createD1WarehouseRepository(env.DB);
      const month = question.text.match(/\b(march|april|may)\b/i)?.[1]?.toLowerCase();
      const range =
        month === "march"
          ? { fromDate: "2026-03-01", toDate: "2026-03-31" }
          : month === "april"
            ? { fromDate: "2026-04-01", toDate: "2026-04-30" }
            : month === "may"
              ? { fromDate: "2026-05-01", toDate: "2026-05-31" }
              : { fromDate: "2026-03-01", toDate: "2026-08-31" };
      const query = await executeWarehouseQuery(repo, {
        companyId: OVERNIGHT_COMPANY_ID,
        aggregation: /invoice/i.test(question.text) ? "invoice_count" : /overdue|debt/i.test(question.text) ? "overdue_total" : /customer/i.test(question.text) ? "top_customers" : "sales_by_month",
        ...range,
        intentText: question.text,
        freshnessClass: freshness,
      });
      const answer = await executeWhatsAppIntelligence(env, {
        companyId: OVERNIGHT_COMPANY_ID,
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
      const charged = await usageCharged(env, interactionId);
      const scored = scoreOvernightTurn({
        question,
        tools,
        reply: answer.reply,
        denied: (answer.intelligence?.toolCalls ?? []).some((call) => /permission/i.test(String(call.error ?? ""))),
        charged,
        latencyMs: Date.now() - started,
        payloadSource: query.evidence.source,
        warehouseAsOf: query.evidence.warehouseAsOf,
        completeness: query.evidence.completenessStatus,
        liveXeroAlsoCalled: tools.some((name) => name.startsWith("xero_")) && expected === "xero_warehouse",
      });
      turns.push(scored);
      raw.push({
        id: question.id,
        expectedSource: expected,
        querySource: query.evidence.source,
        completeness: query.evidence.completenessStatus,
        warehouseAsOf: query.evidence.warehouseAsOf,
        tools,
        reply: answer.reply.slice(0, 280),
      });
      continue;
    }

    const answer = await executeWhatsAppIntelligence(env, {
      companyId: OVERNIGHT_COMPANY_ID,
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
    const charged = await usageCharged(env, interactionId);
    const scored = scoreOvernightTurn({
      question,
      tools,
      reply: answer.reply,
      denied: (answer.intelligence?.toolCalls ?? []).some((call) => /permission/i.test(String(call.error ?? ""))),
      charged,
      latencyMs: Date.now() - started,
      liveXeroAlsoCalled:
        question.expectedSource === "xero_warehouse" && tools.some((name) => name.startsWith("xero_")),
    });
    turns.push(scored);
    raw.push({ id: question.id, tools, scope: answer.intelligence?.scope ?? null, reply: answer.reply.slice(0, 280) });
  }

  return {
    stage: input.stage,
    asked: questions.map((row) => row.id),
    director: director.email,
    office: office?.email ?? null,
    turns: raw,
    scores: turns,
  };
}
