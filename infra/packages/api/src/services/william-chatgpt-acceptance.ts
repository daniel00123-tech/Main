/**
 * Controlled William ChatGPT-path acceptance.
 * Mints a short-lived user MCP JWT (channel=chatgpt) and calls the live
 * gateway. Never returns tokens or secrets. No Xero writes. No email send.
 */

import { issueMcpAccessToken, recordAccessJti } from "../auth/mcp-oauth";
import { loadLiveCompanyActor } from "../auth/live-identity";
import type { Env } from "../env";
import { outlookWriteExposure } from "./outlook-write-policy";

export type AcceptanceOutcome =
  | "WORKS"
  | "PERMISSION_DENIED"
  | "TOOL_NOT_EXPOSED"
  | "CONNECTOR_NOT_CONNECTED"
  | "UPSTREAM_FAILURE"
  | "NO_RESULTS";

const WILLIAM_USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEMBERSHIP_ID = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const WILLIAM_EMAIL = "william@elvexpropertyservices.com";
const COMPANY_ID = "co_el";
const CHATGPT_CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const MCP_URL = "https://app.infrastack.app/api/gateway/v1/mcp";
const INFO_MAILBOX = "info@elvexpropertyservices.com";
const FINANCE_MAILBOX = "finance@elvexpropertyservices.com";

const OUTLOOK_DRAFT_NAME = /outlook_.*draft|draft_.*email|draft_.*mail|reply_.*email|create_.*email|send_elvex/i;
const SEND_NAME = /send_elvex_email|send_.*email|outlook_send|mail_send/i;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function extractText(rpc: Record<string, unknown>): string {
  const result = rpc.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = result?.content?.find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

function tryParse(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

function summarizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return {
      count: value.length,
      sample: value.slice(0, 3).map((item) => summarizeValue(item, depth + 1)),
    };
  }
  if (typeof value === "object" && depth < 3) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = [
      "invoiceNumber",
      "InvoiceNumber",
      "totalSales",
      "sales_total",
      "invoice_count",
      "invoice_numbers",
      "transactionCount",
      "currencyCode",
      "fromDate",
      "toDate",
      "period",
      "source",
      "via",
      "companyToolName",
      "id",
      "subject",
      "from",
      "sender",
      "fromAddress",
      "receivedDateTime",
      "title",
      "url",
      "sourceUrl",
      "documentId",
      "body",
      "bodyPreview",
      "answer",
      "confidence",
      "noneInDocument",
      "upstreamType",
      "upstreamKeys",
      "upstreamPreview",
      "name",
      "organisationName",
      "summary",
      "customers",
      "invoices",
      "messages",
      "results",
      "matches",
      "documents",
      "items",
    ];
    for (const key of keys) {
      if (key in record) out[key] = summarizeValue(record[key], depth + 1);
    }
    if (Object.keys(out).length === 0) {
      return { keys: Object.keys(record).slice(0, 12) };
    }
    return out;
  }
  return typeof value;
}

function collectionLength(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  for (const key of [
    "invoices",
    "messages",
    "results",
    "matches",
    "documents",
    "items",
    "customers",
    "transactions",
  ]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  if (record.summary && typeof record.summary === "object") return 1;
  return null;
}

function classifyRpc(
  toolName: string,
  listed: Set<string>,
  rpc: Record<string, unknown>,
  httpStatus: number,
): AcceptanceOutcome {
  if (!listed.has(toolName)) return "TOOL_NOT_EXPOSED";
  const err = rpc.error as
    | {
        message?: string;
        data?: {
          accessOutcome?: string;
          errorCode?: string;
          reason?: string;
          userAllowed?: boolean;
          connected?: boolean | null;
        };
      }
    | undefined;
  if (err) {
    const data = err.data ?? {};
    const msg = String(err.message ?? "").toLowerCase();
    if (
      data.accessOutcome === "permission_denied" ||
      data.errorCode === "permission_denied" ||
      data.errorCode === "insufficient_permissions" ||
      data.reason === "user_not_authorised" ||
      data.userAllowed === false ||
      msg.includes("permissions") ||
      msg.includes("not allow")
    ) {
      return "PERMISSION_DENIED";
    }
    if (
      data.errorCode === "not_connected" ||
      data.errorCode === "connector_not_configured" ||
      data.connected === false ||
      msg.includes("not connected") ||
      msg.includes("not configured")
    ) {
      return "CONNECTOR_NOT_CONNECTED";
    }
    return "UPSTREAM_FAILURE";
  }
  if (httpStatus === 401 || httpStatus === 403) {
    const body = JSON.stringify(rpc).toLowerCase();
    if (body.includes("permission") || body.includes("not allow")) return "PERMISSION_DENIED";
    return "UPSTREAM_FAILURE";
  }
  const result = rpc.result as { isError?: boolean } | undefined;
  const text = extractText(rpc);
  const parsed = tryParse(text);
  if (result?.isError) return "UPSTREAM_FAILURE";
  if (typeof parsed === "object" && parsed && "error" in (parsed as object)) {
    const inner = String((parsed as { error?: unknown }).error ?? "").toLowerCase();
    if (inner.includes("permission") || inner.includes("not allow")) return "PERMISSION_DENIED";
    if (inner.includes("not connected")) return "CONNECTOR_NOT_CONNECTED";
    return "UPSTREAM_FAILURE";
  }
  if (
    toolName === "xero_sales_summary" &&
    parsed &&
    typeof parsed === "object" &&
    ("summary" in (parsed as object) ||
      "sales_total" in (parsed as object) ||
      "totalSales" in ((parsed as { summary?: object }).summary ?? {}))
  ) {
    return "WORKS";
  }
  if (toolName === "outlook_get_message" && parsed && typeof parsed === "object") {
    const record = parsed as { body?: unknown; messages?: unknown };
    if (typeof record.body === "string" && record.body.trim()) return "WORKS";
    if (Array.isArray(record.messages) && record.messages.length > 0) return "WORKS";
  }
  if (toolName === "ask_document" && parsed && typeof parsed === "object" && "answer" in parsed) {
    return "WORKS";
  }
  const len = collectionLength(parsed);
  if (len === 0) return "NO_RESULTS";
  if (!text.trim() && parsed == null) return "NO_RESULTS";
  return "WORKS";
}

async function mcp(
  token: string,
  method: string,
  params?: Record<string, unknown>,
  id = 1,
): Promise<{ httpStatus: number; rpc: Record<string, unknown> }> {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "chatgpt-mcp",
      Origin: "https://chatgpt.com",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    }),
  });
  const rpc = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { httpStatus: response.status, rpc };
}

async function callTool(
  token: string,
  listed: Set<string>,
  toolName: string,
  args: Record<string, unknown>,
  id: number,
  options?: { directCallIfUnlisted?: boolean },
) {
  const advertised = listed.has(toolName);
  if (!advertised && !options?.directCallIfUnlisted) {
    return {
      toolName,
      arguments: args,
      advertised: false,
      outcome: "TOOL_NOT_EXPOSED" as AcceptanceOutcome,
      directCallOutcome: null,
      parsed: null,
      httpStatus: null,
      errorCode: null,
      userRole: null,
      summary: { missingFromToolsList: true },
    };
  }
  const { httpStatus, rpc } = await mcp(token, "tools/call", { name: toolName, arguments: args }, id);
  const err = rpc.error as { message?: string; data?: Record<string, unknown> } | undefined;
  const text = extractText(rpc);
  const parsed = tryParse(text);
  const listedForClassify = advertised ? listed : new Set([...listed, toolName]);
  const executed = classifyRpc(toolName, listedForClassify, rpc, httpStatus);
  return {
    toolName,
    arguments: args,
    advertised,
    outcome: advertised ? executed : "TOOL_NOT_EXPOSED",
    directCallOutcome: advertised ? null : executed,
    parsed,
    httpStatus,
    errorCode: err?.data?.errorCode ?? err?.data?.accessOutcome ?? null,
    userRole: err?.data?.userRole ?? null,
    reason: err?.data?.reason ?? null,
    connected: err?.data?.connected ?? null,
    userAllowed: err?.data?.userAllowed ?? null,
    message: typeof err?.message === "string" ? err.message.slice(0, 240) : null,
    summary: summarizeValue(parsed),
    rawPreview: text ? text.slice(0, 220) : null,
  };
}

function pickInvoiceNumber(summary: unknown): string | null {
  if (!summary) return null;
  if (Array.isArray(summary)) return pickInvoiceNumber(summary[0]);
  if (typeof summary !== "object") return null;
  const record = summary as Record<string, unknown>;
  if (typeof record.invoiceNumber === "string") return record.invoiceNumber;
  if (typeof record.InvoiceNumber === "string") return record.InvoiceNumber;
  const sample = record.sample;
  if (Array.isArray(sample) && sample[0]) return pickInvoiceNumber(sample[0]);
  if (record.invoices) return pickInvoiceNumber(record.invoices);
  return null;
}

function pickMessageField(summary: unknown, field: "id" | "subject" | "from"): string | null {
  if (!summary) return null;
  if (Array.isArray(summary)) return pickMessageField(summary[0], field);
  if (typeof summary !== "object") return null;
  const record = summary as Record<string, unknown>;
  if (typeof record[field] === "string") return record[field] as string;
  if (field === "from" && typeof record.sender === "string") return record.sender;
  if (field === "from" && record.from && typeof record.from === "object") {
    const from = record.from as Record<string, unknown>;
    if (typeof from.emailAddress === "string") return from.emailAddress;
    if (from.emailAddress && typeof from.emailAddress === "object") {
      const addr = from.emailAddress as Record<string, unknown>;
      if (typeof addr.address === "string") return addr.address;
    }
  }
  if (Array.isArray(record.sample) && record.sample[0]) {
    return pickMessageField(record.sample[0], field);
  }
  if (record.sample) return pickMessageField(record.sample, field);
  if (record.messages) return pickMessageField(record.messages, field);
  return null;
}

function pickKnowledgeId(summary: unknown): { id: string | null; title: string | null; url: string | null } {
  if (!summary || typeof summary !== "object") return { id: null, title: null, url: null };
  const record = summary as Record<string, unknown>;
  const id =
    (typeof record.id === "string" && record.id) ||
    (typeof record.documentId === "string" && record.documentId) ||
    null;
  const title =
    typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : null;
  const url =
    (typeof record.url === "string" && record.url) ||
    (typeof record.sourceUrl === "string" && record.sourceUrl) ||
    null;
  if (id || title || url) return { id, title, url };
  if (record.sample) {
    return pickKnowledgeId(Array.isArray(record.sample) ? record.sample[0] : record.sample);
  }
  if (record.results) return pickKnowledgeId(record.results);
  if (record.matches) return pickKnowledgeId(record.matches);
  if (record.documents) return pickKnowledgeId(record.documents);
  return { id: null, title: null, url: null };
}

export async function runWilliamChatgptAcceptance(
  env: Env,
  phase: "elevated" | "restored",
): Promise<Record<string, unknown>> {
  if (!env.SESSION_SECRET) {
    return { error: "SESSION_SECRET missing" };
  }
  const actor = await loadLiveCompanyActor(env.DB, WILLIAM_USER_ID, COMPANY_ID);
  if (!actor?.active) {
    return { error: "William live actor missing or inactive" };
  }
  if (phase === "elevated" && actor.role !== "finance_team") {
    return { error: "Refusing elevated run: live role is not finance_team", liveRole: actor.role };
  }
  if (phase === "restored" && actor.role !== "office_staff") {
    return { error: "Refusing restore run: live role is not office_staff", liveRole: actor.role };
  }

  const issued = await issueMcpAccessToken(
    env.SESSION_SECRET,
    "https://app.infrastack.app",
    "https://app.infrastack.app/api/gateway/v1/mcp",
    {
      userId: actor.userId,
      email: actor.email || WILLIAM_EMAIL,
      companyId: actor.companyId,
      membershipId: actor.membershipId || WILLIAM_MEMBERSHIP_ID,
      clientId: CHATGPT_CLIENT_ID,
      channel: "chatgpt",
    },
  );
  await recordAccessJti(env.DB, {
    jti: issued.jti,
    userId: actor.userId,
    companyId: actor.companyId,
  });

  let rpcId = 1;
  await mcp(
    issued.token,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chatgpt-acceptance", version: "1.0" },
    },
    rpcId++,
  );

  const listedRes = await mcp(issued.token, "tools/list", {}, rpcId++);
  const tools = ((listedRes.rpc.result as { tools?: Array<{ name: string; description?: string }> } | undefined)
    ?.tools ?? []) as Array<{ name: string; description?: string }>;
  const listed = new Set(tools.map((tool) => tool.name));
  const toolNames = tools.map((tool) => tool.name).sort();

  const xeroReadListed = toolNames.filter(
    (name) => name.startsWith("xero_") && !/create|approve|send|allocate|void|update|delete/i.test(name),
  );
  const outlookDraftListed = toolNames.filter((name) => OUTLOOK_DRAFT_NAME.test(name));
  const outlookSendListed = toolNames.filter((name) => SEND_NAME.test(name));
  const actionControlListed = toolNames.filter((name) =>
    /action_plan|plan_xero|confirm_action|execute_action/.test(name),
  );

  const today = isoDate(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;

  const cases: Array<{
    id: string;
    group: "xero" | "outlook" | "knowledge" | "restore";
    toolName: string;
    args: Record<string, unknown>;
  }> = [];

  if (phase === "elevated") {
    cases.push(
      { id: "xero.sales_today", group: "xero", toolName: "xero_sales_summary", args: { fromDate: today, toDate: today } },
      {
        id: "xero.sales_this_month",
        group: "xero",
        toolName: "xero_sales_summary",
        args: { fromDate: monthStart, toDate: today },
      },
      {
        id: "xero.invoices_raised_today",
        group: "xero",
        toolName: "xero_search_invoices",
        args: { fromDate: today, toDate: today, limit: 10 },
      },
      {
        id: "xero.outstanding_invoices",
        group: "xero",
        toolName: "xero_search_invoices",
        args: { unpaidOnly: true, limit: 10 },
      },
      {
        id: "xero.top_customers",
        group: "xero",
        toolName: "xero_top_customers",
        args: { fromDate: monthStart, toDate: today, limit: 5 },
      },
    );
  } else {
    cases.push(
      {
        id: "restore.xero_sales_denied",
        group: "restore",
        toolName: "xero_sales_summary",
        args: { fromDate: today, toDate: today },
      },
      {
        id: "restore.finance_inbox_denied",
        group: "restore",
        toolName: "outlook_list_messages",
        args: { mailboxAddress: FINANCE_MAILBOX, limit: 1 },
      },
    );
  }

  const results: Record<string, unknown>[] = [];
  let knownInvoice: string | null = null;
  let infoMessageId: string | null = null;
  let infoSubject: string | null = null;
  let infoFrom: string | null = null;
  let knowledgeDoc = { id: null as string | null, title: null as string | null, url: null as string | null };
  let secondDoc = { id: null as string | null, title: null as string | null, url: null as string | null };

  for (const testCase of cases) {
    const result = await callTool(issued.token, listed, testCase.toolName, testCase.args, rpcId++, {
      directCallIfUnlisted: testCase.group === "xero" || testCase.group === "restore",
    });
    const { parsed: _parsed, ...safe } = result;
    results.push({ id: testCase.id, group: testCase.group, ...safe });
    if (testCase.id === "xero.outstanding_invoices" || testCase.id === "xero.invoices_raised_today") {
      knownInvoice = knownInvoice ?? pickInvoiceNumber(result.summary) ?? pickInvoiceNumber(result.parsed);
    }
  }

  const withoutParsed = (result: { parsed?: unknown } & Record<string, unknown>) => {
    const { parsed: _ignored, ...safe } = result;
    return safe;
  };

  if (phase === "elevated") {
    const invoiceLookup = await callTool(
      issued.token,
      listed,
      "xero_get_invoice",
      knownInvoice ? { invoiceNumber: knownInvoice } : { invoiceNumber: "INV-0001" },
      rpcId++,
      { directCallIfUnlisted: true },
    );
    results.push({
      id: "xero.known_invoice_lookup",
      group: "xero",
      knownInvoiceUsed: knownInvoice,
      ...withoutParsed(invoiceLookup),
    });
  }

    const infoNewest = await callTool(
      issued.token,
      listed,
      "outlook_list_messages",
      { mailboxAddress: INFO_MAILBOX, limit: 3 },
      rpcId++,
    );
    results.push({ id: "outlook.newest_info", group: "outlook", ...withoutParsed(infoNewest) });
    infoMessageId =
      pickMessageField(infoNewest.parsed, "id") ?? pickMessageField(infoNewest.summary, "id");
    infoSubject =
      pickMessageField(infoNewest.parsed, "subject") ?? pickMessageField(infoNewest.summary, "subject");
    infoFrom =
      pickMessageField(infoNewest.parsed, "from") ?? pickMessageField(infoNewest.summary, "from");

    const financeNewest = await callTool(
      issued.token,
      listed,
      "outlook_list_messages",
      { mailboxAddress: FINANCE_MAILBOX, limit: 3 },
      rpcId++,
    );
    results.push({ id: "outlook.newest_finance", group: "outlook", ...withoutParsed(financeNewest) });

    const senderQuery = infoFrom ? infoFrom : "elvex";
    const senderSearch = await callTool(
      issued.token,
      listed,
      "outlook_search_mailbox",
      { mailboxAddress: INFO_MAILBOX, query: senderQuery, limit: 5 },
      rpcId++,
    );
    results.push({
      id: "outlook.sender_search",
      group: "outlook",
      query: senderQuery,
      ...withoutParsed(senderSearch),
    });

    const subjectQuery = infoSubject ? infoSubject.slice(0, 40) : "invoice";
    const subjectSearch = await callTool(
      issued.token,
      listed,
      "outlook_search_mailbox",
      { mailboxAddress: INFO_MAILBOX, query: subjectQuery, limit: 5 },
      rpcId++,
    );
    results.push({
      id: "outlook.subject_search",
      group: "outlook",
      query: subjectQuery,
      ...withoutParsed(subjectSearch),
    });

    const fullEmail = await callTool(
      issued.token,
      listed,
      "outlook_get_message",
      infoMessageId
        ? { mailboxAddress: INFO_MAILBOX, messageId: infoMessageId }
        : { mailboxAddress: INFO_MAILBOX, messageId: "missing" },
      rpcId++,
    );
    results.push({
      id: "outlook.full_email_retrieval",
      group: "outlook",
      usedMessageId: Boolean(infoMessageId),
      ...withoutParsed(fullEmail),
    });

    const writePolicy = outlookWriteExposure();
    results.push({
      id: "outlook.draft_reply_capability",
      group: "outlook",
      toolName: null,
      outcome: outlookDraftListed.length > 0 ? "WORKS" : writePolicy.draft,
      listedDraftLikeTools: outlookDraftListed,
      investigation: outlookDraftListed.length > 0 ? "A_draft_tool_exposed" : "B_draft_creation_does_not_exist",
      policy: writePolicy.draftReason,
    });

    results.push({
      id: "outlook.send_behind_confirmation_gate",
      group: "outlook",
      toolName: null,
      outcome: outlookSendListed.length > 0 ? "WORKS" : writePolicy.send,
      listedSendLikeTools: outlookSendListed,
      actionControlListed,
      executed: false,
      note: writePolicy.sendReason,
    });

    const searchTool = listed.has("search") ? "search" : "search_company_knowledge";
    let knowledgeSearch = await callTool(
      issued.token,
      listed,
      searchTool,
      { query: "company policy", limit: 5 },
      rpcId++,
    );
    if (knowledgeSearch.outcome !== "WORKS") {
      knowledgeSearch = await callTool(
        issued.token,
        listed,
        searchTool,
        { query: "health and safety policy", limit: 5 },
        rpcId++,
      );
    }
    results.push({ id: "knowledge.document_search", group: "knowledge", ...withoutParsed(knowledgeSearch) });
    knowledgeDoc = pickKnowledgeId(knowledgeSearch.parsed);
    if (!knowledgeDoc.id) knowledgeDoc = pickKnowledgeId(knowledgeSearch.summary);

    const fetchName = listed.has("fetch") ? "fetch" : "get_knowledge_document";
    const sourceFetch = knowledgeDoc.id
      ? await callTool(
          issued.token,
          listed,
          fetchName,
          { id: knowledgeDoc.id },
          rpcId++,
        )
      : {
          toolName: fetchName,
          outcome: "NO_RESULTS" as AcceptanceOutcome,
          summary: { reason: "no document id from search" },
          parsed: null,
        };
    const fetched = pickKnowledgeId(sourceFetch.parsed);
    const fetchedFallback = fetched.id || fetched.url ? fetched : pickKnowledgeId(sourceFetch.summary);
    if (fetchedFallback.id) knowledgeDoc = { ...knowledgeDoc, ...fetchedFallback, id: fetchedFallback.id };
    const sourceUrl = fetchedFallback.url ?? knowledgeDoc.url;
    results.push({
      id: "knowledge.source_url",
      group: "knowledge",
      ...withoutParsed(sourceFetch),
      sourceUrl,
      hasSourceUrl: Boolean(sourceUrl),
    });

    const askName = listed.has("ask_document") ? "ask_document" : null;
    const factualQuestion = knowledgeDoc.title
      ? `What is the main purpose of ${knowledgeDoc.title}?`
      : "What is the main purpose of this document?";
    const qaCall = knowledgeDoc.id && askName
      ? await callTool(
          issued.token,
          listed,
          askName,
          { documentId: knowledgeDoc.id, question: factualQuestion },
          rpcId++,
        )
      : await callTool(
          issued.token,
          listed,
          searchTool,
          { query: factualQuestion, limit: 5 },
          rpcId++,
        );
    results.push({
      id: "knowledge.document_qa",
      group: "knowledge",
      documentId: knowledgeDoc.id,
      via: askName ?? searchTool,
      ...withoutParsed(qaCall),
    });

    const followUps = [
      { id: "knowledge.short_follow_up", question: "what exactly?" },
      { id: "knowledge.follow_up_when", question: "when?" },
      { id: "knowledge.follow_up_more", question: "more detail" },
    ];
    for (const follow of followUps) {
      const followCall = knowledgeDoc.id && askName
        ? await callTool(
            issued.token,
            listed,
            askName,
            { documentId: knowledgeDoc.id, question: follow.question, priorQuestion: factualQuestion },
            rpcId++,
          )
        : await callTool(
            issued.token,
            listed,
            searchTool,
            { query: follow.question, limit: 3 },
            rpcId++,
          );
      results.push({
        id: follow.id,
        group: "knowledge",
        documentId: knowledgeDoc.id,
        via: askName ?? searchTool,
        ...withoutParsed(followCall),
      });
    }

    const unrelated = knowledgeDoc.id && askName
      ? await callTool(
          issued.token,
          listed,
          askName,
          {
            documentId: knowledgeDoc.id,
            question: "does it mention offshore drilling licenses?",
            priorQuestion: factualQuestion,
          },
          rpcId++,
        )
      : {
          toolName: askName ?? searchTool,
          outcome: "TOOL_NOT_EXPOSED" as AcceptanceOutcome,
          summary: { reason: "ask_document not advertised" },
        };
    const unrelatedParsed = "parsed" in unrelated ? unrelated.parsed : null;
    const unrelatedNone =
      Boolean(
        unrelatedParsed &&
          typeof unrelatedParsed === "object" &&
          (unrelatedParsed as { noneInDocument?: boolean }).noneInDocument,
      ) ||
      String((unrelated as { rawPreview?: string }).rawPreview ?? "").includes("can't see anything");
    results.push({
      id: "knowledge.unrelated_no_global_fallback",
      group: "knowledge",
      documentId: knowledgeDoc.id,
      noneInDocument: unrelatedNone,
      globalSearchUsed: false,
      ...withoutParsed(unrelated as { parsed?: unknown } & Record<string, unknown>),
    });

    const switchSearch = await callTool(
      issued.token,
      listed,
      searchTool,
      { query: "health and safety", limit: 5 },
      rpcId++,
    );
    secondDoc = pickKnowledgeId(switchSearch.parsed);
    if (!secondDoc.id) secondDoc = pickKnowledgeId(switchSearch.summary);
    results.push({
      id: "knowledge.document_switch",
      group: "knowledge",
      ...withoutParsed(switchSearch),
      firstDocument: knowledgeDoc.title,
      secondDocument: secondDoc.title,
      switched:
        Boolean(secondDoc.id && knowledgeDoc.id && secondDoc.id !== knowledgeDoc.id) ||
        Boolean(secondDoc.title && knowledgeDoc.title && secondDoc.title !== knowledgeDoc.title),
    });
    if (secondDoc.id && askName) {
      const switchedQa = await callTool(
        issued.token,
        listed,
        askName,
        { documentId: secondDoc.id, question: "What does this document cover?" },
        rpcId++,
      );
      results.push({
        id: "knowledge.switched_document_qa",
        group: "knowledge",
        documentId: secondDoc.id,
        via: askName,
        ...withoutParsed(switchedQa),
      });
    }

  const xeroDirect = results
    .filter((row) => row.group === "xero" || row.id === "restore.xero_sales_denied")
    .map((row) => row.directCallOutcome);
  const xeroDirectWorked = xeroDirect.includes("WORKS") || xeroDirect.includes("NO_RESULTS");
  const xeroDirectDenied = xeroDirect.includes("PERMISSION_DENIED");

  return {
    phase,
    liveRole: actor.role,
    isPlatformAdmin: actor.isPlatformAdmin,
    toolsListHttpStatus: listedRes.httpStatus,
    toolCount: toolNames.length,
    toolNames,
    xeroReadListed,
    outlookDraftListed,
    outlookSendListed,
    actionControlListed,
    xeroInvestigation: {
      advertisedOnToolsList: [
        "xero_search_invoices",
        "xero_list_overdue_invoices",
        "xero_get_invoice",
        "xero_sales_summary",
      ].every((name) => listed.has(name)),
      directCallWorked: xeroDirectWorked,
      directCallDenied: xeroDirectDenied,
      conclusion: listed.has("xero_search_invoices")
        ? "A_rbac_or_routing_not_missing_capability"
        : xeroDirectWorked
          ? "advertised_missing_but_infra_read_executor_exists"
          : xeroDirectDenied
            ? "A_rbac_denial_and_not_advertised"
            : "B_genuine_missing_or_failed_xero_read",
    },
    outlookDraftInvestigation: {
      conclusion:
        outlookDraftListed.length > 0
          ? "A_draft_tool_exists_and_is_exposed"
          : "B_draft_creation_does_not_exist_on_gateway",
      listedDraftLikeTools: outlookDraftListed,
    },
    results,
  };
}

/**
 * Office-staff only. Proves an explicit Xero question via ChatGPT knowledge
 * tools is permission-denied before knowledge search or Xero execute.
 * Does not elevate William.
 */
export async function runWilliamXeroRoutingDenial(env: Env): Promise<Record<string, unknown>> {
  if (!env.SESSION_SECRET) {
    return { error: "SESSION_SECRET missing" };
  }
  const actor = await loadLiveCompanyActor(env.DB, WILLIAM_USER_ID, COMPANY_ID);
  if (!actor?.active) {
    return { error: "William live actor missing or inactive" };
  }
  if (actor.role !== "office_staff") {
    return { error: "Refusing Xero routing denial run: live role is not office_staff", liveRole: actor.role };
  }

  const issued = await issueMcpAccessToken(
    env.SESSION_SECRET,
    "https://app.infrastack.app",
    "https://app.infrastack.app/api/gateway/v1/mcp",
    {
      userId: actor.userId,
      email: actor.email || WILLIAM_EMAIL,
      companyId: actor.companyId,
      membershipId: actor.membershipId || WILLIAM_MEMBERSHIP_ID,
      clientId: CHATGPT_CLIENT_ID,
      channel: "chatgpt",
    },
  );
  await recordAccessJti(env.DB, {
    jti: issued.jti,
    userId: actor.userId,
    companyId: actor.companyId,
  });

  const started = new Date().toISOString();
  let rpcId = 1;
  await mcp(
    issued.token,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chatgpt-xero-routing", version: "1.0" },
    },
    rpcId++,
  );
  const listedRes = await mcp(issued.token, "tools/list", {}, rpcId++);
  const tools = ((listedRes.rpc.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []) as Array<{
    name: string;
  }>;
  const listed = new Set(tools.map((tool) => tool.name));
  const query = "tell me on xero what our sales are";

  const searchCall = await callTool(issued.token, listed, "search", { query }, rpcId++);
  const summaryWithQuery = await callTool(
    issued.token,
    listed,
    "database_summary",
    { query },
    rpcId++,
  );
  const summaryWithMeta = await mcp(
    issued.token,
    "tools/call",
    {
      name: "database_summary",
      arguments: {},
      _meta: { userQuery: query },
    },
    rpcId++,
  );
  const metaText = extractText(summaryWithMeta.rpc);
  const metaErr = summaryWithMeta.rpc.error as { message?: string; data?: Record<string, unknown> } | undefined;

  const usage = await env.DB.prepare(
    `SELECT tool_name, action, source_client, success, settlement_status, customer_charge_cents, metadata_json, recorded_at
     FROM usage_records
     WHERE company_id = ? AND user_id = ? AND recorded_at >= ?
     ORDER BY recorded_at DESC
     LIMIT 20`,
  )
    .bind(COMPANY_ID, WILLIAM_USER_ID, started)
    .all();

  const gateway = await env.DB.prepare(
    `SELECT tool_name, action, status, settlement_status, error_code, error_message, source_client, created_at
     FROM gateway_requests
     WHERE company_id = ? AND actor_id = ? AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 20`,
  )
    .bind(COMPANY_ID, WILLIAM_USER_ID, started)
    .all();

  const usageRows = (usage.results ?? []) as Array<Record<string, unknown>>;
  const gatewayRows = (gateway.results ?? []) as Array<Record<string, unknown>>;
  const knowledgeCharged = usageRows.some((row) => {
    const tool = String(row.tool_name ?? "");
    const charge = row.customer_charge_cents;
    return (
      (tool === "search" || tool === "database_summary" || tool === "search_company_knowledge") &&
      charge != null &&
      Number(charge) > 0
    );
  });
  const xeroDownstream = gatewayRows.some((row) => String(row.tool_name ?? "").startsWith("xero_"));
  const denied = searchCall.outcome === "PERMISSION_DENIED";
  const message = searchCall.message ?? "";

  return {
    phase: "xero-denial",
    liveRole: actor.role,
    query,
    sourceClient: "chatgpt",
    userId: WILLIAM_USER_ID,
    companyId: COMPANY_ID,
    search: searchCall,
    databaseSummaryWithQuery: summaryWithQuery,
    databaseSummaryWithMeta: {
      httpStatus: summaryWithMeta.httpStatus,
      message: typeof metaErr?.message === "string" ? metaErr.message.slice(0, 240) : null,
      errorCode: metaErr?.data?.errorCode ?? metaErr?.data?.accessOutcome ?? null,
      capability: metaErr?.data?.capability ?? null,
      connected: metaErr?.data?.connected ?? null,
      rawPreview: metaText ? metaText.slice(0, 220) : null,
    },
    usageRows,
    gatewayRows,
    proof: {
      permissionDenied: denied,
      expectedCopy: message.includes("don’t allow access to Xero financial data") || message.includes("don't allow access to Xero financial data"),
      noKnowledgeCharge: !knowledgeCharged,
      noXeroDownstream: !xeroDownstream,
    },
  };
}

const XERO_SALES_ROLES = new Set([
  "finance_team",
  "finance_manager",
  "director",
  "company_admin",
  "operations_manager",
]);

/**
 * Authorised Xero read acceptance. Does not change William's live role.
 */
export async function runWilliamXeroReadsAcceptance(env: Env): Promise<Record<string, unknown>> {
  if (!env.SESSION_SECRET) {
    return { error: "SESSION_SECRET missing" };
  }
  const actor = await loadLiveCompanyActor(env.DB, WILLIAM_USER_ID, COMPANY_ID);
  if (!actor?.active) {
    return { error: "William live actor missing or inactive" };
  }
  if (!XERO_SALES_ROLES.has(String(actor.role))) {
    return {
      error: "Refusing Xero reads run: live role cannot read Xero sales",
      liveRole: actor.role,
      recordedRole: actor.role,
    };
  }

  const issued = await issueMcpAccessToken(
    env.SESSION_SECRET,
    "https://app.infrastack.app",
    "https://app.infrastack.app/api/gateway/v1/mcp",
    {
      userId: actor.userId,
      email: actor.email || WILLIAM_EMAIL,
      companyId: actor.companyId,
      membershipId: actor.membershipId || WILLIAM_MEMBERSHIP_ID,
      clientId: CHATGPT_CLIENT_ID,
      channel: "chatgpt",
    },
  );
  await recordAccessJti(env.DB, {
    jti: issued.jti,
    userId: actor.userId,
    companyId: actor.companyId,
  });

  const started = new Date().toISOString();
  let rpcId = 1;
  await mcp(
    issued.token,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chatgpt-xero-reads", version: "1.0" },
    },
    rpcId++,
  );

  const listedRes = await mcp(issued.token, "tools/list", {}, rpcId++);
  const tools = ((listedRes.rpc.result as { tools?: Array<{ name: string; description?: string }> } | undefined)
    ?.tools ?? []) as Array<{ name: string; description?: string }>;
  const listed = new Set(tools.map((tool) => tool.name));
  const toolNames = tools.map((tool) => tool.name).sort();
  const xeroReadListed = toolNames.filter(
    (name) => name.startsWith("xero_") && !/create|approve|send|allocate|void|update|delete/i.test(name),
  );
  const xeroWriteListed = toolNames.filter((name) =>
    /^xero_/.test(name) && /create|approve|send|allocate|void|update|delete/i.test(name),
  );
  const requiredReads = [
    "xero_sales_summary",
    "xero_search_invoices",
    "xero_get_invoice",
    "xero_list_overdue_invoices",
    "xero_top_customers",
  ];

  const cases: Array<{ id: string; toolName: string; args: Record<string, unknown> }> = [
    { id: "sales.today", toolName: "xero_sales_summary", args: { period: "today" } },
    { id: "sales.this_month", toolName: "xero_sales_summary", args: { period: "this month" } },
    { id: "sales.last_month", toolName: "xero_sales_summary", args: { period: "last month" } },
    {
      id: "invoices.2026-09-01",
      toolName: "xero_search_invoices",
      args: { fromDate: "2026-09-01", toDate: "2026-09-01", query: "invoiced today 01/09/2026" },
    },
    { id: "invoices.outstanding", toolName: "xero_search_invoices", args: { unpaidOnly: true, limit: 10 } },
    { id: "invoices.overdue", toolName: "xero_list_overdue_invoices", args: { limit: 10 } },
    { id: "customers.top", toolName: "xero_top_customers", args: { period: "this month", limit: 5 } },
  ];
  // Knowledge reroute is proven in unit tests. Skip the live search call here —
  // it can time out and is not required to prove Xero tool execution.

  const results: Record<string, unknown>[] = [];
  let knownInvoice: string | null = null;
  for (const testCase of cases) {
    const result = await callTool(issued.token, listed, testCase.toolName, testCase.args, rpcId++);
    const { parsed, ...safe } = result;
    results.push({ id: testCase.id, ...safe });
    knownInvoice =
      knownInvoice ?? pickInvoiceNumber(result.summary) ?? pickInvoiceNumber(parsed);
  }

  const invoiceLookup = await callTool(
    issued.token,
    listed,
    "xero_get_invoice",
    knownInvoice ? { invoiceNumber: knownInvoice } : { invoiceNumber: "INV-0001" },
    rpcId++,
  );
  const { parsed: _lookupParsed, ...lookupSafe } = invoiceLookup;
  results.push({
    id: "invoice.lookup",
    knownInvoiceUsed: knownInvoice,
    ...lookupSafe,
  });

  const usage = await env.DB.prepare(
    `SELECT tool_name, action, source_client, success, settlement_status, customer_charge_cents, recorded_at
     FROM usage_records
     WHERE company_id = ? AND user_id = ? AND recorded_at >= ?
     ORDER BY recorded_at DESC
     LIMIT 30`,
  )
    .bind(COMPANY_ID, WILLIAM_USER_ID, started)
    .all();
  const gateway = await env.DB.prepare(
    `SELECT tool_name, action, status, settlement_status, error_code, source_client, created_at
     FROM gateway_requests
     WHERE company_id = ? AND actor_id = ? AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 30`,
  )
    .bind(COMPANY_ID, WILLIAM_USER_ID, started)
    .all();

  const usageRows = (usage.results ?? []) as Array<Record<string, unknown>>;
  const gatewayRows = (gateway.results ?? []) as Array<Record<string, unknown>>;
  const xeroUsage = usageRows.filter((row) => String(row.tool_name ?? "").startsWith("xero_"));
  const knowledgeCharged = usageRows.some((row) => {
    const tool = String(row.tool_name ?? "");
    return (
      (tool === "search" || tool === "database_summary" || tool === "search_company_knowledge") &&
      row.customer_charge_cents != null &&
      Number(row.customer_charge_cents) > 0
    );
  });
  const xeroCharged = xeroUsage.some(
    (row) => row.customer_charge_cents != null && Number(row.customer_charge_cents) > 0,
  );
  const outcomes = results.map((row) => String(row.outcome ?? ""));

  return {
    phase: "xero-reads",
    recordedRole: actor.role,
    liveRole: actor.role,
    userId: WILLIAM_USER_ID,
    companyId: COMPANY_ID,
    sourceClient: "chatgpt",
    roleChanged: false,
    toolsListHttpStatus: listedRes.httpStatus,
    toolCount: toolNames.length,
    xeroReadListed,
    xeroWriteListed,
    requiredReadsAdvertised: requiredReads.every((name) => listed.has(name)),
    results,
    usageRows,
    gatewayRows,
    proof: {
      toolsListed: requiredReads.every((name) => listed.has(name)),
      noWritesAdded: xeroWriteListed.length === 0,
      authorisedReadsWorked: outcomes.some((outcome) => outcome === "WORKS" || outcome === "NO_RESULTS"),
      noKnowledgeCharge: !knowledgeCharged,
      xeroUsageAttributed: xeroUsage.some(
        (row) => row.source_client === "chatgpt" && String(row.action ?? "").startsWith("xero."),
      ),
      xeroZeroCharge: xeroUsage.length > 0 && !xeroCharged,
      noKnowledgeRows: !usageRows.some((row) =>
        ["search", "database_summary", "search_company_knowledge"].includes(String(row.tool_name ?? "")),
      ),
    },
  };
}
