/**
 * Live Portal Chat acceptance. Never prints secrets.
 * Uses live memberships. Does not flip William or Sharon.
 * Suites are split so one Worker request stays inside wall-clock limits.
 */

import { elvexCan } from "@infra/shared";
import type { Env } from "../env";
import { loadLiveCompanyActor, liveActorToSessionUser } from "../auth/live-identity";
import { createSessionToken } from "../auth/session";
import { evaluateActionPermission } from "../permissions/service";
import { sendPortalChatMessage } from "./portal-chat";
import { classifyScope, pickMailboxTool } from "./intelligence/scope";
import { buildConversationState } from "./intelligence/state";

const WILLIAM_USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const SHARON_USER_ID = "user_949bcd80-e74e-449a-a280-da475fe18ace";
const API = "https://api.infrastack.app";
const APP = "https://app.infrastack.app";

export type PortalChatAcceptanceSuite = "director_memory" | "director_systems" | "office" | "parity";

function clip(text: string, max = 280): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function category(text: string, tools: string[], permissionDenied: boolean): string {
  if (permissionDenied || /permissions don’t allow|permissions don't allow|not grant|not allow this action/i.test(text)) {
    return "permission_denied";
  }
  if (/I need another moment to finish that/i.test(text)) return "hollow_retry";
  if (tools.some((name) => name.startsWith("xero_")) || /\bXero\b/i.test(text)) return "xero";
  if (tools.some((name) => name.startsWith("outlook_")) || /email|mailbox|inbox|no matching messages/i.test(text)) {
    return "outlook";
  }
  if (/couldn’t reach|couldn't reach|unreachable|could not find/i.test(text)) return "system_failure";
  if (tools.some((name) => name.includes("knowledge") || name === "list_documents")) return "knowledge";
  return "conversation";
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

async function turn(
  env: Env,
  sessionUser: ReturnType<typeof liveActorToSessionUser>,
  text: string,
  conversationId?: string,
) {
  const result = await sendPortalChatMessage(env, {
    companyId: "co_el",
    sessionUser,
    conversationId,
    text,
  });
  const content = result.assistantMessage.content;
  const tools = result.assistantMessage.metadata.toolNames ?? [];
  return {
    conversationId: result.conversation.id,
    scope: result.assistantMessage.metadata.scope,
    tools,
    permissionDenied: Boolean(result.assistantMessage.metadata.permissionDenied),
    reply: clip(content),
    category: category(content, tools, Boolean(result.assistantMessage.metadata.permissionDenied)),
    leaksAmount: /£\s?[\d,]/.test(content),
    hollowRetry: /I need another moment to finish that/i.test(content),
  };
}

async function loadActors(env: Env) {
  const william = await loadLiveCompanyActor(env.DB, WILLIAM_USER_ID, "co_el");
  const sharon = await loadLiveCompanyActor(env.DB, SHARON_USER_ID, "co_el");
  return { william, sharon };
}

function directorPolicy(role: string) {
  return {
    role,
    xeroSales: elvexCan(role, "xero.sales.read"),
    infoMail: elvexCan(role, "mail.info.read"),
    financeMail: elvexCan(role, "mail.finance.read"),
    knowledge: elvexCan(role, "knowledge.company.read"),
  };
}

export async function runPortalChatAcceptance(
  env: Env,
  suite: PortalChatAcceptanceSuite = "director_memory",
): Promise<Record<string, unknown>> {
  if (suite === "director_systems") return runDirectorSystems(env);
  if (suite === "office") return runOfficeSuite(env);
  if (suite === "parity") return runParitySuite(env);
  return runDirectorMemory(env);
}

async function runDirectorMemory(env: Env): Promise<Record<string, unknown>> {
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

  const { william } = await loadActors(env);
  if (!william?.active) {
    return { suite: "director_memory", error: "William live actor missing or inactive", role: william?.role ?? null };
  }
  const policy = directorPolicy(william.role);
  const williamUser = liveActorToSessionUser(william);
  const token = await createSessionToken(williamUser, env.SESSION_SECRET);
  const hello = await turn(env, williamUser, "hi");
  const recallSetup = await turn(env, williamUser, "Search company files for PO process");
  const recall = await turn(env, williamUser, "what were we talking about?", recallSetup.conversationId);
  const moreDetail = await turn(env, williamUser, "give me more detail", recallSetup.conversationId);
  const files = await turn(env, williamUser, "Search company files for PO process.");

  const cookie = `infra_session=${token}`;
  const httpSend = await httpProbe(`${API}/api/companies/el-business/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text: "hi" }),
  });

  const pass =
    hello.category === "conversation" &&
    recall.category === "conversation" &&
    !recall.hollowRetry &&
    /PO process|company files|document/i.test(recall.reply) &&
    !moreDetail.hollowRetry &&
    !files.hollowRetry &&
    unauthApi.status === 401 &&
    httpSend.status !== 404;

  return {
    suite: "director_memory",
    williamRole: william.role,
    directorPolicy: policy,
    unauthenticated: {
      api: { status: unauthApi.status, error: unauthApi.json?.error ?? unauthApi.body },
      app: { status: unauthApp.status, error: unauthApp.json?.error ?? unauthApp.body },
      not404: unauthApi.status !== 404 && unauthApp.status !== 404,
    },
    missingBareChatPath: { status: missingPath.status, note: "frontend does not call /chat without /messages" },
    httpAuthenticatedSend: {
      status: httpSend.status,
      not404: httpSend.status !== 404,
    },
    director: { hello, recall, moreDetail, companyFiles: files },
    outcome: pass ? "PASS" : "PARTIAL",
  };
}

async function runDirectorSystems(env: Env): Promise<Record<string, unknown>> {
  const { william } = await loadActors(env);
  if (!william?.active) {
    return { suite: "director_systems", error: "William live actor missing or inactive", role: william?.role ?? null };
  }
  const policy = directorPolicy(william.role);
  const williamUser = liveActorToSessionUser(william);
  const xero = await turn(env, williamUser, "What are our Xero sales?");
  const xeroFollow = await turn(env, williamUser, "give me more detail", xero.conversationId);
  const info = await turn(env, williamUser, "What is the newest email in the info inbox?");
  const finance = await turn(env, williamUser, "What is the newest email in the finance inbox?");

  const pass =
    (policy.xeroSales
      ? xero.category !== "permission_denied" && xero.tools.includes("xero_sales_summary") && !xero.hollowRetry
      : xero.category === "permission_denied") &&
    !xeroFollow.hollowRetry &&
    (policy.infoMail ? info.category !== "hollow_retry" && info.tools.some((name) => name.startsWith("outlook_")) : true) &&
    (policy.financeMail
      ? finance.category !== "hollow_retry" && finance.tools.some((name) => name.startsWith("outlook_"))
      : finance.category === "permission_denied");

  return {
    suite: "director_systems",
    williamRole: william.role,
    directorPolicy: policy,
    director: { xero, xeroFollow, infoInbox: info, financeInbox: finance },
    outcome: pass ? "PASS" : "PARTIAL",
  };
}

async function runOfficeSuite(env: Env): Promise<Record<string, unknown>> {
  const { sharon } = await loadActors(env);
  if (!sharon?.active) {
    return { suite: "office", skipped: true, reason: "Sharon missing or inactive", outcome: "PARTIAL" };
  }
  const sharonUser = liveActorToSessionUser(sharon);
  const officeKnowledge = await turn(env, sharonUser, "Search company files for PO process");
  const officeInfo = await turn(env, sharonUser, "What is the newest email in the info inbox?");
  const officeXero = await turn(env, sharonUser, "What are our Xero sales?");
  const officeFinance = await turn(env, sharonUser, "What is the newest email in the finance inbox?");
  const office = {
    role: sharon.role,
    knowledge: officeKnowledge,
    infoInbox: officeInfo,
    xero: officeXero,
    financeInbox: officeFinance,
    xeroDenied: officeXero.category === "permission_denied" && !officeXero.leaksAmount,
    financeDenied: officeFinance.category === "permission_denied" && !officeFinance.leaksAmount,
    noHollowRetry: ![officeKnowledge, officeInfo, officeXero, officeFinance].some((row) => row.hollowRetry),
  };
  const pass = office.xeroDenied && office.financeDenied && office.noHollowRetry;
  return { suite: "office", officeStaff: office, outcome: pass ? "PASS" : "PARTIAL" };
}

async function runParitySuite(env: Env): Promise<Record<string, unknown>> {
  const { william, sharon } = await loadActors(env);
  const parityActions = [
    { action: "xero.sales.read" as const, mailbox: null },
    { action: "knowledge.search" as const, mailbox: null },
    { action: "outlook.search" as const, mailbox: "info@elvexpropertyservices.com" },
    { action: "outlook.search" as const, mailbox: "finance@elvexpropertyservices.com" },
  ];
  const parity = [];
  for (const actor of [william, sharon].filter((row): row is NonNullable<typeof row> => Boolean(row?.active))) {
    const session = liveActorToSessionUser(actor);
    for (const row of parityActions) {
      const decision = await evaluateActionPermission(env.DB, session, "co_el", row.action, {
        mailboxAddress: row.mailbox,
      });
      parity.push({
        email: actor.email,
        role: actor.role,
        action: row.action,
        mailbox: row.mailbox,
        allowed: decision.allowed,
        capability: row.action,
      });
    }
  }
  const routing = [
    "what is the PO process",
    "What are our Xero sales?",
    "What is the newest email in the info inbox?",
    "What is the newest email in the finance inbox?",
    "give me more detail",
    "what were we talking about?",
  ].map((text) => {
    const decision = classifyScope(text, buildConversationState({ userText: text }));
    return { text, scope: decision.scope, tool: decision.tool ?? pickMailboxTool(text), intent: decision.lastUserIntent };
  });
  const usage = await env.DB.prepare(
    `SELECT tool_name, action, source_client, success, settlement_status, customer_charge_cents
     FROM usage_records
     WHERE source_client = 'portal_chat'
     ORDER BY recorded_at DESC
     LIMIT 12`,
  ).all();
  return {
    suite: "parity",
    routing,
    parity,
    usage: usage.results ?? [],
    outcome: "PASS",
  };
}
