/**
 * Office-staff RBAC proof. Uses Sharon (preferred) or Lauren.
 * Does not change anyone's lasting role. GATED if no portal session identity exists.
 */

import { elvexCan } from "@infra/shared";
import type { Env } from "../env";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
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
  const finance = await sendPortalChatMessage(env, {
    companyId: COMPANY_ID,
    sessionUser,
    conversationId: xero.conversation.id,
    text: "Show me the newest email in the finance inbox.",
  });
  const info = await sendPortalChatMessage(env, {
    companyId: COMPANY_ID,
    sessionUser,
    conversationId: xero.conversation.id,
    text: "Show me the newest email in the info inbox.",
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
  const financeDenied =
    Boolean(finance.assistantMessage.metadata.permissionDenied) ||
    /permission|not allow|don.?t currently have permission/i.test(finance.assistantMessage.content);
  const xeroTools = (xero.assistantMessage.metadata.toolNames ?? []).join(",");
  const leakedFinance = /subject|from:|finance@/i.test(finance.assistantMessage.content) && !financeDenied;
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
      leaked: leakedFinance,
      reply: clip(finance.assistantMessage.content),
    },
    info: {
      tools: info.assistantMessage.metadata.toolNames,
      reply: clip(info.assistantMessage.content),
      allowed: !info.assistantMessage.metadata.permissionDenied,
    },
    usage: usage.results ?? [],
    charged,
    verdict:
      xeroDenied && financeDenied && !leakedFinance && !knowledgeUsedForXero && !charged && !elvexCan(actor.role, "xero.sales.read")
        ? "PASS"
        : "FAIL",
  };
}
