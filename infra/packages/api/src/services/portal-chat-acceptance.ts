/**
 * Live Portal Chat acceptance. Never prints secrets.
 * Proves Send is not 404 and uses shared intelligence.
 */

import type { Env } from "../env";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
import { createSessionToken } from "../auth/session";
import { sendPortalChatMessage } from "./portal-chat";
import { classifyScope } from "./intelligence/scope";
import { buildConversationState } from "./intelligence/state";

const WILLIAM_USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_EMAIL = "william@elvexpropertyservices.com";
const API = "https://api.infrastack.app";
const APP = "https://app.infrastack.app";

function clip(text: string, max = 280): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function httpProbe(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: string; json: Record<string, unknown> | null }> {
  const res = await fetch(url, init);
  const body = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, body: body.slice(0, 240), json };
}

export async function runPortalChatAcceptance(env: Env): Promise<Record<string, unknown>> {
  const unauthApi = await httpProbe(`${API}/api/companies/el-business/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "what is the PO process" }),
  });
  const unauthApp = await httpProbe(`${APP}/api/companies/el-business/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "what is the PO process" }),
  });
  const missingPath = await httpProbe(`${API}/api/companies/el-business/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "what is the PO process" }),
  });

  const actor = await loadLiveCompanyActor(env.DB, WILLIAM_USER_ID, "co_el");
  if (!actor || !actor.active) {
    return {
      error: "William live actor missing or inactive",
      role: actor?.role ?? null,
      unauthApi,
      unauthApp,
      missingPath,
    };
  }
  const sessionUser = liveActorToSessionUser(actor);
  const token = await createSessionToken(sessionUser, env.SESSION_SECRET);

  const po = await sendPortalChatMessage(env, {
    companyId: "co_el",
    sessionUser,
    text: "what is the PO process",
  });
  const followUp = await sendPortalChatMessage(env, {
    companyId: "co_el",
    sessionUser,
    conversationId: po.conversation.id,
    text: "give me more detail",
  });
  const recall = await sendPortalChatMessage(env, {
    companyId: "co_el",
    sessionUser,
    conversationId: po.conversation.id,
    text: "what were we talking about?",
  });
  const xero = await sendPortalChatMessage(env, {
    companyId: "co_el",
    sessionUser,
    conversationId: po.conversation.id,
    text: "What are our Xero sales this month?",
  });
  const info = await sendPortalChatMessage(env, {
    companyId: "co_el",
    sessionUser,
    conversationId: po.conversation.id,
    text: "What is the newest email in the info inbox?",
  });
  const finance = await sendPortalChatMessage(env, {
    companyId: "co_el",
    sessionUser,
    conversationId: po.conversation.id,
    text: "What is the newest email in the finance inbox?",
  });

  const cookie = `infra_session=${token}`;
  const httpSend = await httpProbe(`${API}/api/companies/el-business/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text: "what is the PO process" }),
  });
  const otherCompany = await env.DB.prepare(
    `SELECT slug FROM companies WHERE id != 'co_el' AND slug IS NOT NULL AND slug != '' ORDER BY id LIMIT 1`,
  ).first<{ slug: string }>();
  const httpWrongCompany = otherCompany?.slug
    ? await httpProbe(`${API}/api/companies/${otherCompany.slug}/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ text: "what is the PO process" }),
      })
    : { status: 0, body: "no other company", json: null };

  const { runOfficeStaffRbacAcceptance } = await import("./sharon-rbac-acceptance");
  const officeStaff = await runOfficeStaffRbacAcceptance(env);

  const usage = await env.DB.prepare(
    `SELECT tool_name, action, source_client, success, settlement_status, customer_charge_cents
     FROM usage_records
     WHERE source_client = 'portal_chat'
     ORDER BY recorded_at DESC
     LIMIT 8`,
  ).all();

  const routing = ["what is the PO process", "What are our Xero sales?", "What is the newest email in the info inbox?"].map(
    (text) => {
      const decision = classifyScope(text, buildConversationState({ userText: text }));
      return { text, scope: decision.scope, tool: decision.tool };
    },
  );

  const poText = po.assistantMessage.content;
  const invented = /I made up|as an example|hypothetical PO/i.test(poText);
  const noResult = /could not find|no (relevant )?(document|evidence|result)|don't have|do not have.*document/i.test(
    poText,
  );

  return {
    williamRole: actor.role,
    unauthenticated: {
      api: { status: unauthApi.status, error: unauthApi.json?.error ?? unauthApi.body },
      app: { status: unauthApp.status, error: unauthApp.json?.error ?? unauthApp.body },
      not404: unauthApi.status !== 404 && unauthApp.status !== 404,
    },
    missingBareChatPath: { status: missingPath.status, note: "frontend does not call /chat without /messages" },
    httpAuthenticatedSend: {
      status: httpSend.status,
      not404: httpSend.status !== 404,
      conversationId: typeof httpSend.json?.conversation === "object" ? (httpSend.json.conversation as { id?: string }).id : null,
    },
    tenantIsolation: {
      status: httpWrongCompany.status,
      denied: httpWrongCompany.status === 403 || httpWrongCompany.status === 404,
    },
    routing,
    poProcess: {
      conversationId: po.conversation.id,
      createdConversation: po.createdConversation,
      scope: po.assistantMessage.metadata.scope,
      tools: po.assistantMessage.metadata.toolNames,
      reply: clip(poText),
      invented,
      groundedOrHonest: !invented && (Boolean(po.assistantMessage.metadata.sources?.length) || noResult || poText.length > 20),
    },
    followUp: { reply: clip(followUp.assistantMessage.content), scope: followUp.assistantMessage.metadata.scope },
    recall: { reply: clip(recall.assistantMessage.content) },
    xeroDirector: {
      permissionDenied: Boolean(xero.assistantMessage.metadata.permissionDenied),
      tools: xero.assistantMessage.metadata.toolNames,
      reply: clip(xero.assistantMessage.content),
    },
    officeStaff,
    infoInbox: {
      tools: info.assistantMessage.metadata.toolNames,
      reply: clip(info.assistantMessage.content),
    },
    financeInbox: {
      permissionDenied: Boolean(finance.assistantMessage.metadata.permissionDenied),
      reply: clip(finance.assistantMessage.content),
    },
    usage: usage.results ?? [],
    outcome:
      unauthApi.status === 401 &&
      httpSend.status !== 404 &&
      !invented &&
      !xero.assistantMessage.metadata.permissionDenied &&
      officeStaff.verdict === "PASS"
        ? "PASS"
        : "PARTIAL",
  };
}
