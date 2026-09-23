/**
 * Ella ChatGPT-path Xero read acceptance.
 * Uses her live director membership. Does not change her role.
 * Never returns tokens or secrets. Read-only.
 */

import { issueMcpAccessToken, recordAccessJti } from "../auth/mcp-oauth";
import { loadLiveCompanyActor } from "../auth/live-identity";
import { elvexCan } from "@infra/shared";
import type { Env } from "../env";

const ELLA_USER_ID = "user_68f7ca07-bd98-44d3-ba61-eea8fe4d6e96";
const ELLA_MEMBERSHIP_ID = "membership_d1b8142e-e9c0-4db9-b270-7e2f583f4791";
const ELLA_EMAIL = "ella@elvexpropertyservices.com";
const COMPANY_ID = "co_el";
const CHATGPT_CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const MCP_URL = "https://app.infrastack.app/api/gateway/v1/mcp";

const REQUIRED_XERO_READS = [
  "xero_sales_summary",
  "xero_search_invoices",
  "xero_get_invoice",
  "xero_list_overdue_invoices",
  "xero_top_customers",
] as const;

function londonCivilDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
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
    return { raw: text.slice(0, 240) };
  }
}

function summarize(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    "source",
    "via",
    "companyToolName",
    "sales_total",
    "invoice_count",
    "invoice_numbers",
    "fromDate",
    "toDate",
    "period",
    "summary",
    "invoiceNumber",
    "notLiveXero",
    "message",
  ]) {
    if (key in record) out[key] = record[key];
  }
  return Object.keys(out).length ? out : { keys: Object.keys(record).slice(0, 12) };
}

function classify(toolName: string, listed: Set<string>, rpc: Record<string, unknown>, httpStatus: number) {
  if (!listed.has(toolName)) return "TOOL_NOT_EXPOSED";
  const err = rpc.error as { message?: string; data?: { errorCode?: string; accessOutcome?: string } } | undefined;
  if (err) {
    const code = String(err.data?.errorCode ?? err.data?.accessOutcome ?? "");
    if (code.includes("permission") || String(err.message ?? "").toLowerCase().includes("permission")) {
      return "PERMISSION_DENIED";
    }
    return "UPSTREAM_FAILURE";
  }
  if (httpStatus === 401 || httpStatus === 403) return "UPSTREAM_FAILURE";
  const parsed = tryParse(extractText(rpc));
  if (parsed && typeof parsed === "object" && "notLiveXero" in (parsed as object)) return "WRONG_TOOL";
  if (toolName === "xero_sales_summary" && parsed && typeof parsed === "object") {
    if ("sales_total" in (parsed as object) || "summary" in (parsed as object)) return "WORKS";
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { invoices?: unknown }).invoices)) {
    return (parsed as { invoices: unknown[] }).invoices.length === 0 ? "NO_RESULTS" : "WORKS";
  }
  if (extractText(rpc).trim()) return "WORKS";
  return "NO_RESULTS";
}

async function mcp(token: string, method: string, params?: Record<string, unknown>, id = 1) {
  const response = await fetch(MCP_URL, {
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

export async function runEllaChatgptXeroAcceptance(env: Env): Promise<Record<string, unknown>> {
  if (!env.SESSION_SECRET) return { error: "SESSION_SECRET missing" };
  const actor = await loadLiveCompanyActor(env.DB, ELLA_USER_ID, COMPANY_ID);
  if (!actor?.active) return { error: "Ella live actor missing or inactive" };

  const recordedRole = actor.role;
  const canSales = elvexCan(actor.role, "xero.sales.read");

  const issued = await issueMcpAccessToken(
    env.SESSION_SECRET,
    "https://app.infrastack.app",
    "https://app.infrastack.app/api/gateway/v1/mcp",
    {
      userId: actor.userId,
      email: actor.email || ELLA_EMAIL,
      companyId: actor.companyId,
      membershipId: actor.membershipId || ELLA_MEMBERSHIP_ID,
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
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ella-chatgpt-acceptance", version: "1.0" },
    },
    rpcId++,
  );
  const listedRes = await mcp(issued.token, "tools/list", {}, rpcId++);
  const tools = ((listedRes.rpc.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map(
    (tool) => tool.name,
  );
  const listed = new Set(tools);
  const today = londonCivilDate();
  const cases = [
    {
      id: "sales.today",
      toolName: "xero_sales_summary",
      args: { fromDate: today, toDate: today, period: "today" },
    },
    {
      id: "sales.this_month",
      toolName: "xero_sales_summary",
      args: { fromDate: `${today.slice(0, 7)}-01`, toDate: today, period: "this month" },
    },
    {
      id: "sales.last_month",
      toolName: "xero_sales_summary",
      args: { fromDate: "2026-08-01", toDate: "2026-08-31", period: "last month" },
    },
    {
      id: "invoices.today",
      toolName: "xero_search_invoices",
      args: { fromDate: today, toDate: today, invoiceType: "ACCREC", limit: 25 },
    },
    {
      id: "invoices.outstanding",
      toolName: "xero_search_invoices",
      args: { unpaidOnly: true, limit: 25 },
    },
    {
      id: "invoices.overdue",
      toolName: "xero_list_overdue_invoices",
      args: { limit: 25 },
    },
    {
      id: "customers.top",
      toolName: "xero_top_customers",
      args: { limit: 5 },
    },
    {
      id: "wrong_tool.database_summary",
      toolName: "database_summary",
      args: {},
    },
  ];

  const results: Record<string, unknown>[] = [];
  for (const testCase of cases) {
    const call = await mcp(
      issued.token,
      "tools/call",
      { name: testCase.toolName, arguments: testCase.args },
      rpcId++,
    );
    const text = extractText(call.rpc);
    const parsed = tryParse(text);
    results.push({
      id: testCase.id,
      toolName: testCase.toolName,
      arguments: testCase.args,
      advertised: listed.has(testCase.toolName),
      outcome: classify(testCase.toolName, new Set([...listed, testCase.toolName]), call.rpc, call.httpStatus),
      httpStatus: call.httpStatus,
      summary: summarize(parsed),
    });
  }

  const invoiceNumber = results
    .map((row) => {
      const summary = row.summary as { invoice_numbers?: unknown; invoiceNumber?: unknown } | null;
      const numbers = summary?.invoice_numbers;
      if (Array.isArray(numbers) && typeof numbers[0] === "string") return numbers[0];
      return typeof summary?.invoiceNumber === "string" ? summary.invoiceNumber : null;
    })
    .find((value): value is string => Boolean(value));
  if (invoiceNumber) {
    const call = await mcp(
      issued.token,
      "tools/call",
      { name: "xero_get_invoice", arguments: { invoiceNumber } },
      rpcId++,
    );
    results.push({
      id: "invoice.known_lookup",
      toolName: "xero_get_invoice",
      arguments: { invoiceNumber },
      advertised: listed.has("xero_get_invoice"),
      outcome: classify("xero_get_invoice", listed, call.rpc, call.httpStatus),
      httpStatus: call.httpStatus,
      summary: summarize(tryParse(extractText(call.rpc))),
    });
  }

  const usage = await env.DB.prepare(
    `SELECT tool_name, action, source_client, success, settlement_status, customer_charge_cents, recorded_at
     FROM usage_records
     WHERE company_id = ? AND user_id = ? AND recorded_at >= datetime('now', '-20 minutes')
     ORDER BY recorded_at DESC
     LIMIT 20`,
  )
    .bind(COMPANY_ID, ELLA_USER_ID)
    .all();

  const after = await loadLiveCompanyActor(env.DB, ELLA_USER_ID, COMPANY_ID);

  return {
    userId: actor.userId,
    email: actor.email || ELLA_EMAIL,
    membershipId: actor.membershipId,
    recordedRole,
    finalRole: after?.role ?? recordedRole,
    roleChanged: false,
    xeroSalesRead: canSales,
    toolsListHttpStatus: listedRes.httpStatus,
    toolCount: tools.length,
    xeroReadListed: REQUIRED_XERO_READS.filter((name) => listed.has(name)),
    xeroReadMissing: REQUIRED_XERO_READS.filter((name) => !listed.has(name)),
    databaseSummaryListed: listed.has("database_summary"),
    results,
    usage: (usage.results ?? []).map((row) => ({
      toolName: row.tool_name,
      action: row.action,
      sourceClient: row.source_client,
      success: row.success,
      settlementStatus: row.settlement_status,
      customerChargeCents: row.customer_charge_cents,
      recordedAt: row.recorded_at,
    })),
  };
}
