/**
 * Combined EL production acceptance. Read-only. Never prints secrets.
 */

import { classifyScope } from "./intelligence/scope";
import { buildConversationState } from "./intelligence/state";
import { detectQualitySignals } from "./quality-auditor";
import { classifyUsageOutcome } from "@infra/shared";
import { publicProductionLineage } from "./production-lineage";
import { assertProductionSuperstackCapabilities } from "./production-superstack";
import type { Env } from "../env";

const INFO_MAILBOX = "info@elvexpropertyservices.com";

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function mcp(
  token: string,
  method: string,
  params?: Record<string, unknown>,
  id = 1,
) {
  const response = await fetch("https://app.infrastack.app/api/gateway/v1/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "chatgpt-mcp",
      Origin: "https://chatgpt.com",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
  });
  const rpc = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { httpStatus: response.status, rpc };
}

function extractText(rpc: Record<string, unknown>): string {
  const result = rpc.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = result?.content?.find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

function tryParse(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return { raw: text.slice(0, 240) };
  }
}

export async function runElProductionAcceptance(env: Env): Promise<Record<string, unknown>> {
  const { runEllaChatgptXeroAcceptance } = await import("./ella-chatgpt-acceptance");
  const { runOfficeStaffRbacAcceptance } = await import("./sharon-rbac-acceptance");
  const { runPortalChatAcceptance } = await import("./portal-chat-acceptance");
  const { runDocumentCatalogueAcceptance } = await import("./document-catalogue-acceptance");
  const { issueMcpAccessToken, recordAccessJti } = await import("../auth/mcp-oauth");
  const { loadLiveCompanyActor } = await import("../auth/live-identity");

  const guard = assertProductionSuperstackCapabilities();
  const lineage = publicProductionLineage();
  const ella = await runEllaChatgptXeroAcceptance(env);
  const officeStaff = await runOfficeStaffRbacAcceptance(env);
  const portal = await runPortalChatAcceptance(env);
  const catalogue = await runDocumentCatalogueAcceptance(env);

  const whatsappRouting = [
    "Search emails",
    "How many emails has Sharon sent today?",
    "What is the PO process?",
    "Tell me Xero sales this month.",
    "Find the newest OneDrive document.",
    "No, I meant email.",
  ].map((text) => {
    const state =
      text === "No, I meant email."
        ? buildConversationState({
            userText: "Tell me Xero sales this month.",
            lastAnswerTopic: "finance",
            currentScope: "BUSINESS_SYSTEM",
            currentBusinessSystem: "xero",
            lastSuccessfulTool: "xero_sales_summary",
          })
        : buildConversationState({ userText: text });
    const decision = classifyScope(text, state);
    return {
      text,
      scope: decision.scope,
      tool: decision.tool,
      emailNotXero: text.toLowerCase().includes("email") ? !String(decision.tool ?? "").startsWith("xero_") : true,
      processNotXero: /po process/i.test(text) ? !String(decision.tool ?? "").startsWith("xero_") : true,
    };
  });

  let outlookGet: Record<string, unknown> = { verdict: "SKIPPED" };
  const ellaActor = await loadLiveCompanyActor(env.DB, "user_68f7ca07-bd98-44d3-ba61-eea8fe4d6e96", "co_el");
  if (env.SESSION_SECRET && ellaActor?.active) {
    const issued = await issueMcpAccessToken(
      env.SESSION_SECRET,
      "https://app.infrastack.app",
      "https://app.infrastack.app/api/gateway/v1/mcp",
      {
        userId: ellaActor.userId,
        email: ellaActor.email,
        companyId: ellaActor.companyId,
        membershipId: ellaActor.membershipId,
        clientId: "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518",
        channel: "chatgpt",
      },
    );
    await recordAccessJti(env.DB, { jti: issued.jti, userId: ellaActor.userId, companyId: ellaActor.companyId });
    await mcp(issued.token, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "el-production-acceptance", version: "1.0" },
    });
    const listed = await mcp(issued.token, "tools/list");
    const tools = ((listed.rpc.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map(
      (tool) => tool.name,
    );
    const listCall = await mcp(issued.token, "tools/call", {
      name: "outlook_list_messages",
      arguments: { mailboxAddress: INFO_MAILBOX, limit: 1 },
    });
    const listedParsed = tryParse(extractText(listCall.rpc));
    const messages = Array.isArray(listedParsed?.messages)
      ? (listedParsed?.messages as Array<Record<string, unknown>>)
      : Array.isArray(listedParsed?.value)
        ? (listedParsed?.value as Array<Record<string, unknown>>)
        : [];
    const messageId = typeof messages[0]?.id === "string" ? messages[0].id : null;
    let getCall: { httpStatus: number; rpc: Record<string, unknown> } | null = null;
    if (messageId) {
      getCall = await mcp(issued.token, "tools/call", {
        name: "outlook_get_message",
        arguments: { messageId, mailboxAddress: INFO_MAILBOX },
      });
    }
    const getText = getCall ? extractText(getCall.rpc) : "";
    const getParsed = getCall ? tryParse(getText) : null;
    const body =
      (typeof getParsed?.body === "string" && getParsed.body) ||
      (typeof getParsed?.bodyPreview === "string" && getParsed.bodyPreview) ||
      (typeof (getParsed?.message as { body?: unknown } | undefined)?.body === "string"
        ? String((getParsed?.message as { body?: unknown }).body)
        : "") ||
      getText;
    outlookGet = {
      toolsListed: {
        outlook_list_messages: tools.includes("outlook_list_messages"),
        outlook_get_message: tools.includes("outlook_get_message"),
      },
      listHttpStatus: listCall.httpStatus,
      messageId: messageId ? "present" : null,
      getHttpStatus: getCall?.httpStatus ?? null,
      hasBody: body.trim().length > 20,
      preview: clip(body),
      verdict: messageId && body.trim().length > 20 ? "PASS" : messageId ? "PARTIAL" : "NO_RESULTS",
    };
  }

  const qualityDenial = detectQualitySignals({
    interactionId: "int_expected_denial",
    companyId: "co_el",
    usage: [
      {
        toolName: "xero_sales_summary",
        success: 0,
        settlementStatus: "denied",
        metadata: { denied: true, result: "permission_denied" },
      },
    ],
    gateway: [{ errorCode: "forbidden", errorMessage: "Permission denied", status: "denied" }],
  });
  const qualityOk =
    !qualityDenial.some((signal) => signal.category === "tool_call_failed" || signal.category === "auth_permission_failure") &&
    classifyUsageOutcome({
      success: 0,
      settlementStatus: "denied",
      metadata: { denied: true, result: "permission_denied" },
    }).expectedDenial;

  const ellaResults = Array.isArray(ella.results) ? (ella.results as Array<Record<string, unknown>>) : [];
  const ellaXeroPass =
    ella.recordedRole === "director" &&
    Array.isArray(ella.xeroReadMissing) &&
    ella.xeroReadMissing.length === 0 &&
    ella.databaseSummaryListed === false &&
    ellaResults.filter((row) => row.toolName !== "database_summary").every((row) => row.outcome === "WORKS" || row.outcome === "NO_RESULTS");

  return {
    lineage,
    guard,
    roles: {
      ella: ella.recordedRole ?? ella.finalRole,
      william: (portal as { williamRole?: string }).williamRole ?? null,
      officeStaff: officeStaff.email ?? null,
      officeStaffRole: officeStaff.role ?? null,
    },
    ellaXero: ella,
    officeStaff,
    portal,
    catalogue,
    whatsappRouting: {
      mode: "GATED_SHARED_INTELLIGENCE",
      cases: whatsappRouting,
      pass: whatsappRouting.every((row) => row.emailNotXero && row.processNotXero),
    },
    realMeta: {
      mode: "NOT_RUN",
      reason: "No unsolicited Meta outbound. Last REAL META EL usage remains 2026-09-02 unless Daniel sends authorised inbound.",
    },
    outlookGet,
    qualitySemantics: {
      expectedDenialNotOperational: qualityOk,
      signals: qualityDenial.map((signal) => signal.category),
    },
    verdicts: {
      ellaXero: ellaXeroPass ? "PASS" : "PARTIAL",
      officeStaff: officeStaff.verdict,
      portal: (portal as { outcome?: string }).outcome,
      outlookGet: outlookGet.verdict,
      whatsappRouting: whatsappRouting.every((row) => row.emailNotXero && row.processNotXero) ? "PASS" : "FAIL",
      quality: qualityOk ? "PASS" : "FAIL",
      guard: guard.ok ? "PASS" : "FAIL",
    },
  };
}
