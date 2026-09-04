/**
 * Office-staff RBAC proof. Uses Sharon (preferred) or Lauren.
 * Does not change anyone's lasting role. GATED if no portal session identity exists.
 */

import { ELVEX_FINANCE_MAILBOXES, ELVEX_INFO_MAILBOXES, elvexCan } from "@infra/shared";
import type { Env } from "../env";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
import { executeGatewayRequest } from "./gateway";
import { sendPortalChatMessage } from "./portal-chat";

const COMPANY_ID = "co_el";
const OFFICE_STAFF_EMAILS = [
  "sharon@elvexpropertyservices.com",
  "lauren@elvexpropertyservices.com",
] as const;

function clip(text: string, max = 280): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function loadOfficeStaffActor(env: Env) {
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ?
       AND m.status = 'active'
       AND u.status = 'active'
       AND m.role = 'office_staff'
       AND lower(u.email) IN (?, ?)
     ORDER BY CASE lower(u.email) WHEN ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(COMPANY_ID, OFFICE_STAFF_EMAILS[0], OFFICE_STAFF_EMAILS[1], OFFICE_STAFF_EMAILS[0])
    .first<{ user_id: string }>();
  if (!row) return null;
  return loadLiveCompanyActor(env.DB, row.user_id, COMPANY_ID);
}

export async function runOfficeStaffRbacAcceptance(env: Env): Promise<Record<string, unknown>> {
  const actor = await loadOfficeStaffActor(env);
  if (!actor?.active) {
    return {
      mode: "GATED",
      error: "No active Elvex office_staff actor (Sharon/Lauren) available",
      verdict: "GATED",
    };
  }
  if (actor.role !== "office_staff") {
    return {
      mode: "GATED",
      error: "Selected actor is not office_staff",
      email: actor.email,
      role: actor.role,
      verdict: "GATED",
    };
  }

  const sessionUser = liveActorToSessionUser(actor);
  const xero = await sendPortalChatMessage(env, {
    companyId: COMPANY_ID,
    sessionUser,
    text: "Tell me our Xero sales this month.",
  });
  async function ask(text: string, conversationId?: string) {
    return sendPortalChatMessage(env, {
      companyId: COMPANY_ID,
      sessionUser,
      conversationId,
      text,
    });
  }
  const timedOut = (reply: string) => /need another moment|try asking once more|couldn.?t process/i.test(reply);

  let finance = await ask("Show me the newest email in the finance inbox.");
  if (timedOut(finance.assistantMessage.content)) {
    finance = await ask("Show me the newest email in the finance inbox.");
  }
  let info = await ask("Show me the newest email in the info inbox.");
  if (timedOut(info.assistantMessage.content)) {
    info = await ask("Show me the newest email in the info inbox.");
  }

  const gwActor = {
    type: "user" as const,
    user: sessionUser,
    membershipId: actor.membershipId,
    channel: "portal_chat",
  };
  const financeGw = await executeGatewayRequest(env, {
    actor: gwActor,
    companyId: COMPANY_ID,
    toolName: "outlook_list_messages",
    arguments: { mailboxAddress: ELVEX_FINANCE_MAILBOXES[0], limit: 1 },
    sourceClient: "portal_chat",
  });
  const infoGw = await executeGatewayRequest(env, {
    actor: gwActor,
    companyId: COMPANY_ID,
    toolName: "outlook_list_messages",
    arguments: { mailboxAddress: ELVEX_INFO_MAILBOXES[0], limit: 1 },
    sourceClient: "portal_chat",
  });

  const usage = await env.DB.prepare(
    `SELECT tool_name, action, source_client, success, settlement_status, customer_charge_cents, recorded_at
     FROM usage_records
     WHERE company_id = ? AND user_id = ? AND recorded_at >= datetime('now', '-20 minutes')
     ORDER BY recorded_at DESC
     LIMIT 20`,
  )
    .bind(COMPANY_ID, actor.userId)
    .all();

  const xeroDenied =
    Boolean(xero.assistantMessage.metadata.permissionDenied) ||
    /permission|not allow|don.?t currently have permission/i.test(xero.assistantMessage.content);
  const financeGwDenied =
    financeGw.status === 403 ||
    ("accessOutcome" in financeGw && financeGw.accessOutcome === "permission_denied");
  const financeDenied =
    financeGwDenied ||
    Boolean(finance.assistantMessage.metadata.permissionDenied) ||
    /permission|not allow|don.?t currently have permission/i.test(finance.assistantMessage.content);
  const xeroTools = (xero.assistantMessage.metadata.toolNames ?? []).join(",");
  const leakedFinance =
    (financeGw.status === 200 && "result" in financeGw) ||
    (/subject|from:|finance@/i.test(finance.assistantMessage.content) && !financeDenied);
  const infoGwAllowed = infoGw.status === 200;
  const charged = (usage.results ?? []).some(
    (row) => Number(row.customer_charge_cents ?? 0) > 0 && /xero|outlook|finance/i.test(`${row.tool_name} ${row.action}`),
  );
  const knowledgeUsedForXero = /search_company_knowledge|database_summary|^search$/.test(xeroTools);

  return {
    mode: "GATED_PORTAL",
    email: actor.email,
    role: actor.role,
    membershipId: actor.membershipId,
    canXeroSales: elvexCan(actor.role, "xero.sales.read"),
    canFinanceMail: elvexCan(actor.role, "mail.finance.read"),
    canInfoMail: elvexCan(actor.role, "mail.info.read"),
    xero: {
      permissionDenied: xeroDenied,
      tools: xero.assistantMessage.metadata.toolNames,
      reply: clip(xero.assistantMessage.content),
      knowledgeUsed: knowledgeUsedForXero,
    },
    finance: {
      permissionDenied: financeDenied,
      gatewayStatus: financeGw.status,
      accessOutcome: "accessOutcome" in financeGw ? financeGw.accessOutcome : null,
      leaked: leakedFinance,
      chatReply: clip(finance.assistantMessage.content),
    },
    info: {
      tools: info.assistantMessage.metadata.toolNames,
      gatewayStatus: infoGw.status,
      chatReply: clip(info.assistantMessage.content),
      allowed: infoGwAllowed || !info.assistantMessage.metadata.permissionDenied,
    },
    usage: usage.results ?? [],
    charged,
    verdict:
      xeroDenied &&
      financeGwDenied &&
      infoGwAllowed &&
      !leakedFinance &&
      !knowledgeUsedForXero &&
      !charged &&
      !elvexCan(actor.role, "xero.sales.read")
        ? "PASS"
        : "FAIL",
  };
}
