#!/usr/bin/env node
/**
 * Combined-tree live acceptance. Records William's role first.
 * Authorised Xero reads use the existing director role (no finance_team).
 * Denial is proven as temporary office_staff. William finishes as Director.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { persistIntendedRole, readIntendedRole, restoreIntendedRole } from "./lib/william-intended-role.mjs";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.infrastack.app";
const MCP = `${API}/api/gateway/v1/mcp`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";
const TODAY = "2026-09-01";

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1File(sql) {
  const sqlFile = join(apiDir, ".tmp-capability-live.sql");
  writeFileSync(sqlFile, sql);
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile],
    { cwd: apiDir, stdio: "pipe" },
  );
  unlinkSync(sqlFile);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function setRole(role) {
  d1File(
    `UPDATE company_memberships SET role='${role}', updated_at=datetime('now') WHERE id='${WILLIAM_MEM}' AND company_id='co_el';
     INSERT INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
     VALUES ('audit_${randomBytes(8).toString("hex")}', 'co_el', 'membership.role_controlled_acceptance', 'cursor-acceptance', 'company_membership', '${WILLIAM_MEM}', '{"toRole":"${role}","reason":"capability completeness live acceptance","platformAdmin":false}', datetime('now'));`,
  );
  return d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role;
}

async function mintWilliamToken() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const code = randomBytes(32).toString("base64url");
  const codeHash = sha256Hex(code);
  const id = `ocode_${randomBytes(8).toString("hex")}`;
  const expires = new Date(Date.now() + 8 * 60 * 1000).toISOString();
  d1File(`INSERT INTO oauth_authorization_codes (
    id, code_hash, client_id, user_id, company_id, membership_id, redirect_uri,
    code_challenge, code_challenge_method, scope, resource, channel, expires_at, created_at
  ) VALUES (
    '${id}', '${codeHash}', '${CLIENT_ID}', '${WILLIAM_USER}', 'co_el', '${WILLIAM_MEM}',
    '${REDIRECT}', '${challenge}', 'S256', 'mcp', NULL, 'chatgpt', '${expires}', datetime('now')
  );`);
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    httpStatus: res.status,
    accessToken: body.access_token ?? null,
    refreshToken: body.refresh_token ?? null,
    error: body.error ?? null,
  };
}

async function mcp(token, method, params = {}, id = 1) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const raw = await res.text();
  let body = {};
  try {
    body = raw.trim().startsWith("data:")
      ? JSON.parse(raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "{}")
      : JSON.parse(raw);
  } catch {
    body = { parseError: raw.slice(0, 400) };
  }
  return { httpStatus: res.status, body };
}

function toolText(body) {
  const text = body?.result?.content?.find((part) => part.type === "text")?.text;
  if (!text) return { error: body?.error ?? body };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function summarise(payload) {
  const nested = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  const summary = nested?.summary && typeof nested.summary === "object" ? nested.summary : {};
  const invoices = nested?.invoices ?? nested?.Invoices ?? [];
  return {
    fromDate: nested?.fromDate ?? summary.fromDate ?? null,
    toDate: nested?.toDate ?? summary.toDate ?? null,
    totalSales: summary.totalSales ?? nested?.totalSales ?? nested?.sales ?? null,
    invoiceCount: summary.transactionCount ?? (Array.isArray(invoices) ? invoices.length : null),
    firstInvoice: invoices?.[0]?.InvoiceNumber ?? invoices?.[0]?.invoiceNumber ?? null,
    error: payload?.error ?? nested?.error ?? null,
    source: nested?.source ?? payload?.source ?? null,
    keys: nested && typeof nested === "object" ? Object.keys(nested).slice(0, 16) : [],
  };
}

const report = {
  recordedBefore: d1(
    `SELECT role, status, updated_at FROM company_memberships WHERE id='${WILLIAM_MEM}';`,
  )[0],
  intendedRole: readIntendedRole(apiDir),
  workerHealth: null,
  authorised: {},
  catalogue: {},
  outlook: {},
  officeStaff: {},
  finalRole: null,
  oauthStillValid: false,
};
persistIntendedRole(apiDir, report.intendedRole || "director", "capability-completeness-live");

const health = await fetch(`${API}/health`, { headers: { "User-Agent": UA } }).then((r) => r.json());
report.workerHealth = health;

const beforeRole = report.recordedBefore?.role ?? null;
const authorisedRole = beforeRole === "office_staff" ? "director" : beforeRole;
if (beforeRole === "office_staff") {
  report.temporaryAuthorisedRole = setRole("director");
}

try {
  const minted = await mintWilliamToken();
  report.authorised.tokenOk = Boolean(minted.accessToken);
  if (!minted.accessToken) throw new Error(`token ${minted.httpStatus} ${minted.error}`);
  const token = minted.accessToken;
  await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 1);
  const listed = await mcp(token, "tools/list", {}, 2);
  report.authorised.tools = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
  report.authorised.xeroTools = report.authorised.tools.filter(
    (name) => name.startsWith("xero_") || name.includes("xero"),
  );
  report.authorised.catalogueListed = report.authorised.tools.includes("list_company_documents");
  report.authorised.askDocumentListed = report.authorised.tools.includes("ask_document");

  const calls = [
    ["1_sales_today", "xero_sales_summary", { period: "today", fromDate: TODAY, toDate: TODAY }],
    ["2_sales_this_month", "xero_sales_summary", { period: "this month" }],
    ["3_invoices_today_structural", "xero_search_invoices", { fromDate: TODAY, toDate: TODAY }],
    ["4_outstanding", "xero_search_invoices", { unpaidOnly: true, fromDate: "2026-01-01", toDate: TODAY }],
    ["5_overdue", "xero_list_overdue_invoices", {}],
    ["6_top_customers", "xero_top_customers", { period: "this month", limit: 5 }],
    ["8_sales_last_month", "xero_sales_summary", { period: "last month" }],
  ];
  for (const [key, name, args] of calls) {
    const result = await mcp(token, "tools/call", { name, arguments: args }, key);
    report.authorised[key] = {
      httpStatus: result.httpStatus,
      rpcError: result.body?.error ?? null,
      summary: summarise(toolText(result.body)),
    };
  }
  const first =
    report.authorised["4_outstanding"]?.summary?.firstInvoice ||
    report.authorised["3_invoices_today_structural"]?.summary?.firstInvoice;
  if (first) {
    const lookup = await mcp(token, "tools/call", { name: "xero_get_invoice", arguments: { invoiceNumber: first } }, 7);
    report.authorised["7_invoice_lookup"] = {
      invoiceNumber: first,
      httpStatus: lookup.httpStatus,
      rpcError: lookup.body?.error ?? null,
      summary: summarise(toolText(lookup.body)),
    };
  }

  const catalogue = await mcp(
    token,
    "tools/call",
    { name: "list_company_documents", arguments: { sort: "newest", source: "all", limit: 10 } },
    20,
  );
  report.catalogue.newest = {
    httpStatus: catalogue.httpStatus,
    rpcError: catalogue.body?.error ?? null,
    payload: toolText(catalogue.body),
  };
  const latest = await mcp(
    token,
    "tools/call",
    { name: "list_company_documents", arguments: { sort: "latest", source: "onedrive", limit: 10 } },
    21,
  );
  report.catalogue.latest = {
    httpStatus: latest.httpStatus,
    rpcError: latest.body?.error ?? null,
    payload: toolText(latest.body),
  };

  const listedMail = await mcp(
    token,
    "tools/call",
    { name: "outlook_list_messages", arguments: { mailboxAddress: "info@elvexpropertyservices.com", limit: 3 } },
    30,
  );
  const mailPayload = toolText(listedMail.body);
  const messages = mailPayload?.messages ?? mailPayload?.result?.messages ?? [];
  const listId = messages[0]?.id ?? messages[0]?.messageId ?? null;
  report.outlook.list = {
    httpStatus: listedMail.httpStatus,
    rpcError: listedMail.body?.error ?? null,
    count: Array.isArray(messages) ? messages.length : 0,
    firstId: listId,
    keys: messages[0] ? Object.keys(messages[0]).slice(0, 12) : [],
  };
  if (listId) {
    const got = await mcp(
      token,
      "tools/call",
      {
        name: "outlook_get_message",
        arguments: { mailboxAddress: "info@elvexpropertyservices.com", messageId: listId },
      },
      31,
    );
    const gotPayload = toolText(got.body);
    report.outlook.get = {
      httpStatus: got.httpStatus,
      rpcError: got.body?.error ?? null,
      usedListId: true,
      hasBody: Boolean(gotPayload?.body || gotPayload?.bodyPreview || gotPayload?.message?.body),
      keys: gotPayload && typeof gotPayload === "object" ? Object.keys(gotPayload).slice(0, 16) : [],
    };
  }

  if (minted.refreshToken) {
    await fetch(`${API}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: new URLSearchParams({ token: minted.refreshToken, client_id: CLIENT_ID }),
    });
  }
} catch (error) {
  report.authorised.error = error instanceof Error ? error.message : String(error);
}

report.officeStaff.role = setRole("office_staff");
try {
  const minted = await mintWilliamToken();
  report.officeStaff.tokenOk = Boolean(minted.accessToken);
  if (minted.accessToken) {
    const token = minted.accessToken;
    await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 40);
    const listed = await mcp(token, "tools/list", {}, 41);
    const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
    report.officeStaff.xeroTools = names.filter((name) => name.startsWith("xero_") || name.includes("xero"));
    const denied = await mcp(
      token,
      "tools/call",
      { name: "xero_sales_summary", arguments: { period: "today" } },
      42,
    );
    report.officeStaff.salesCall = {
      httpStatus: denied.httpStatus,
      error: denied.body?.error ?? null,
      text: toolText(denied.body),
    };
    if (minted.refreshToken) {
      await fetch(`${API}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: new URLSearchParams({ token: minted.refreshToken, client_id: CLIENT_ID }),
      });
    }
  }
} catch (error) {
  report.officeStaff.error = error instanceof Error ? error.message : String(error);
}

report.restored = restoreIntendedRole(apiDir, "office_staff", "capability completeness live acceptance");
report.finalRole = d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role;
report.oauthStillValid = Boolean(
  d1(
    `SELECT id FROM oauth_refresh_tokens WHERE user_id='${WILLIAM_USER}' AND company_id='co_el' AND revoked_at IS NULL AND expires_at > datetime('now') LIMIT 1;`,
  )[0]?.id,
);
report.recentUsage = d1(
  `SELECT tool_name, action, success, settlement_status, customer_charge_cents, source_client, recorded_at
   FROM usage_records
   WHERE company_id='co_el' AND (actor_email LIKE 'william@%' OR user_id='${WILLIAM_USER}')
   ORDER BY recorded_at DESC LIMIT 16;`,
);

writeFileSync("/tmp/capability-completeness-live.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
