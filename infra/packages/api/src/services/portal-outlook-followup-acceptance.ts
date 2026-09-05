/**
 * Live TEST Portal Chat Outlook follow-up proof.
 * One authenticated sequence. No send. No Outlook draft.
 */

import type { Env } from "../env";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
import { sendPortalChatMessage } from "./portal-chat";

const COMPANY_ID = "co_el";
const DIRECTOR_EMAILS = ["william@elvexpropertyservices.com", "ella@elvexpropertyservices.com"];

const SEQUENCE = [
  "show me the latest info email",
  "what are they asking?",
  "draft me a reply",
  "make it shorter",
  "make it friendlier",
] as const;

function clip(text: string, max = 280): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function outlookTools(names: string[]): string[] {
  return names.filter((name) => /^outlook_/i.test(name));
}

export async function runPortalOutlookFollowupProof(env: Env): Promise<Record<string, unknown>> {
  const placeholders = DIRECTOR_EMAILS.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, lower(u.email) AS email
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ?
       AND m.status = 'active'
       AND u.status = 'active'
       AND m.role IN ('director', 'company_admin')
       AND lower(u.email) IN (${placeholders})
     ORDER BY CASE lower(u.email) WHEN ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(COMPANY_ID, ...DIRECTOR_EMAILS, DIRECTOR_EMAILS[0])
    .first<{ user_id: string; email: string }>();
  if (!row) {
    return { ok: false, error: "No active TEST director actor" };
  }
  const actor = await loadLiveCompanyActor(env.DB, row.user_id, COMPANY_ID);
  if (!actor?.active) {
    return { ok: false, error: "Director actor inactive", email: row.email };
  }
  const sessionUser = liveActorToSessionUser(actor);
  const turns: Array<Record<string, unknown>> = [];
  let conversationId: string | undefined;
  const started = Date.now();

  for (const [index, text] of SEQUENCE.entries()) {
    const result = await sendPortalChatMessage(env, {
      companyId: COMPANY_ID,
      sessionUser,
      conversationId,
      text,
      trafficClass: "TEST",
      userAgent: "InfraAcceptance/1.0",
    });
    conversationId = result.conversation.id;
    const tools = result.assistantMessage.metadata.toolNames ?? [];
    turns.push({
      index: index + 1,
      text,
      tools,
      outlookTools: outlookTools(tools),
      scope: result.assistantMessage.metadata.scope,
      terminal: result.assistantMessage.metadata.terminal,
      permissionDenied: Boolean(result.assistantMessage.metadata.permissionDenied),
      reply: clip(result.assistantMessage.content),
    });
  }

  const allOutlook = turns.flatMap((turn) => (turn.outlookTools as string[]) ?? []);
  const listOrSearch = allOutlook.filter((name) => name === "outlook_list_messages" || name === "outlook_search_mailbox");
  const fetches = allOutlook.filter((name) => name === "outlook_get_message");
  const writes = allOutlook.filter((name) => /send|draft|create|reply|forward/i.test(name));
  const laterOutlook = turns.slice(2).flatMap((turn) => (turn.outlookTools as string[]) ?? []);

  const usage = conversationId
    ? await env.DB.prepare(
        `SELECT traffic_class, source_client, COALESCE(SUM(customer_charge_cents), 0) AS charge, COUNT(*) AS n
         FROM daily_improvement_interactions
         WHERE conversation_id = ?
         GROUP BY traffic_class, source_client`,
      )
        .bind(conversationId)
        .all<{ traffic_class: string; source_client: string; charge: number; n: number }>()
        .catch(() => ({ results: [] }))
    : { results: [] };

  const chargeRows = await env.DB.prepare(
    `SELECT COALESCE(customer_charge_cents, 0) AS charge, tool_name, source_client
     FROM usage_records
     WHERE recorded_at >= ?
       AND actor_email = ?
       AND source_client = 'portal_chat'
     ORDER BY recorded_at DESC
     LIMIT 20`,
  )
    .bind(new Date(started - 5_000).toISOString(), actor.email)
    .all<{ charge: number; tool_name: string; source_client: string }>()
    .catch(() => ({ results: [] }));

  const ok =
    listOrSearch.length >= 1 &&
    fetches.length <= 1 &&
    writes.length === 0 &&
    laterOutlook.length === 0 &&
    turns.length === SEQUENCE.length;

  return {
    ok,
    actor: { email: actor.email, role: actor.role },
    trafficClass: "TEST",
    conversationId,
    turns,
    outlookToolCount: allOutlook.length,
    initialListOrSearch: listOrSearch,
    fullMessageFetches: fetches,
    laterOutlookAfterBody: laterOutlook,
    writes,
    noSend: writes.length === 0,
    noOutlookDraft: !allOutlook.some((name) => /draft/i.test(name)),
    usageRecent: usage.results ?? [],
    chargeByClass: chargeRows.results ?? [],
    expected: {
      initialListOrSearch: true,
      oneFullFetchWhenBodyRequired: fetches.length <= 1,
      noSecondFetchOnceBodyRetained: laterOutlook.length === 0,
      noSend: true,
      noOutlookDraft: true,
    },
  };
}
