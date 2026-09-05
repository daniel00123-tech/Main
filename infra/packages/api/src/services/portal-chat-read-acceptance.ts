/**
 * Live Portal Chat read-path acceptance. Uses existing company actors.
 * Does not invent credentials or change roles.
 */

import type { Env } from "../env";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
import { isGenericRetryCopy } from "./intelligence/verbalise-business.js";
import { sendPortalChatMessage } from "./portal-chat";

const COMPANY_ID = "co_el";
const DIRECTOR_EMAILS = ["ella@elvexpropertyservices.com", "william@elvexpropertyservices.com"];
const OFFICE_EMAILS = ["sharon@elvexpropertyservices.com", "lauren@elvexpropertyservices.com"];

function clip(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function loadRoleActor(env: Env, role: "director" | "office_staff", emails: string[]) {
  const placeholders = emails.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, lower(u.email) AS email
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
    .bind(COMPANY_ID, role, ...emails, emails[0])
    .first<{ user_id: string; email: string }>();
  if (!row) return null;
  return loadLiveCompanyActor(env.DB, row.user_id, COMPANY_ID);
}

export async function runPortalChatReadAcceptance(env: Env): Promise<Record<string, unknown>> {
  const directorActor = await loadRoleActor(env, "director", DIRECTOR_EMAILS);
  const officeActor = await loadRoleActor(env, "office_staff", OFFICE_EMAILS);
  if (!directorActor?.active || !officeActor?.active) {
    return {
      mode: "GATED",
      verdict: "GATED",
      error: "Missing active director or office_staff actor",
      director: directorActor?.email ?? null,
      office: officeActor?.email ?? null,
    };
  }

  const tallies = {
    success: 0,
    permission_denied: 0,
    no_results: 0,
    upstream_failure: 0,
    timeout: 0,
    clarify: 0,
    other: 0,
  };
  const turns: Array<Record<string, unknown>> = [];

  async function runTurn(
    label: string,
    actor: NonNullable<typeof directorActor>,
    text: string,
    conversationId?: string,
  ) {
    const started = Date.now();
    const sessionUser = liveActorToSessionUser(actor);
    const result = await sendPortalChatMessage(env, {
      companyId: COMPANY_ID,
      sessionUser,
      conversationId,
      text,
      trafficClass: "TEST",
      userAgent: "InfraAcceptance/1.0",
    });
    const reply = result.assistantMessage.content;
    const terminal = String(result.assistantMessage.metadata.terminal ?? "other");
    if (terminal in tallies) tallies[terminal as keyof typeof tallies] += 1;
    else tallies.other += 1;
    turns.push({
      label,
      role: actor.role,
      text,
      tools: result.assistantMessage.metadata.toolNames,
      scope: result.assistantMessage.metadata.scope,
      terminal,
      permissionDenied: Boolean(result.assistantMessage.metadata.permissionDenied),
      genericRetry: isGenericRetryCopy(reply),
      latencyMs: Date.now() - started,
      reply: clip(reply),
      conversationId: result.conversation.id,
    });
    return result;
  }

  const po = await runTurn("director_po", directorActor, "What is the PO process?");
  const conversationId = po.conversation.id;
  await runTurn("director_more_detail", directorActor, "Give me more detail.", conversationId);
  const recall = await runTurn("director_memory", directorActor, "What were we talking about?", conversationId);
  const xero = await runTurn("director_xero", directorActor, "What are our Xero sales this month?", conversationId);
  const info = await runTurn("director_info", directorActor, "What is the newest email in the info inbox?", conversationId);
  const finance = await runTurn("director_finance", directorActor, "What is the newest email in the finance inbox?", conversationId);
  await runTurn("director_newest_doc", directorActor, "What is the newest document?", conversationId);
  await runTurn("director_hi", directorActor, "hi", conversationId);

  const officeXero = await runTurn("office_xero", officeActor, "Tell me our Xero sales this month.");
  const officeConv = officeXero.conversation.id;
  const officeInfo = await runTurn("office_info", officeActor, "What is the newest email in the info inbox?", officeConv);
  const officeFinance = await runTurn("office_finance", officeActor, "What is the newest email in the finance inbox?", officeConv);
  await runTurn("office_po", officeActor, "What is the PO process?", officeConv);

  const genericOnSuccess = turns.filter(
    (turn) => turn.genericRetry && Array.isArray(turn.tools) && (turn.tools as string[]).length > 0 && turn.terminal === "success",
  );
  const history = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM portal_conversation_messages WHERE conversation_id = ?`,
  )
    .bind(conversationId)
    .first<{ n: number }>();

  const verdict =
    !isGenericRetryCopy(info.assistantMessage.content) &&
    !isGenericRetryCopy(xero.assistantMessage.content) &&
    !isGenericRetryCopy(po.assistantMessage.content) &&
    /po process|purchase order|talking about/i.test(recall.assistantMessage.content) &&
    Boolean(officeXero.assistantMessage.metadata.permissionDenied) &&
    Boolean(officeFinance.assistantMessage.metadata.permissionDenied) &&
    !officeInfo.assistantMessage.metadata.permissionDenied &&
    genericOnSuccess.length === 0 &&
    tallies.timeout === 0
      ? "PASS"
      : "FAIL";

  return {
    mode: "LIVE",
    director: { email: directorActor.email, role: directorActor.role },
    office: { email: officeActor.email, role: officeActor.role },
    tallies,
    liveTurns: turns.length,
    historyPersisted: Number(history?.n ?? 0) >= 2,
    genericOnSuccessfulTool: genericOnSuccess.length,
    financeDirectorDenied: Boolean(finance.assistantMessage.metadata.permissionDenied),
    verdict,
    turns,
  };
}
