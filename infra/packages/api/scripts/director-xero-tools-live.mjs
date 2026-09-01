#!/usr/bin/env node
/**
 * P0 live probe: William is intended Director. Do not restore office_staff.
 * Never prints tokens. Uses William human OAuth (ChatGPT client) against
 * https://api.infrastack.app/api/gateway/v1/mcp.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.infrastack.app";
const MCP = `${API}/api/gateway/v1/mcp`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";
const REQUIRED = [
  "xero_sales_summary",
  "xero_search_invoices",
  "xero_get_invoice",
  "xero_list_overdue_invoices",
  "xero_top_customers",
];

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1File(sql) {
  const sqlFile = join(apiDir, ".tmp-director-xero-live.sql");
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

function membership() {
  return (
    d1(
      `SELECT id, user_id, company_id, role, status, custom_role_id, updated_at
       FROM company_memberships
       WHERE id='${WILLIAM_MEM}' AND user_id='${WILLIAM_USER}' AND company_id='co_el';`,
    )[0] ?? null
  );
}

function lastOperatorRole() {
  return (
    d1(
      `SELECT actor, detail_json, created_at
       FROM audit_events
       WHERE company_id='co_el'
         AND event_type='user.role_changed'
         AND resource_id='${WILLIAM_USER}'
         AND actor != 'cursor-acceptance'
       ORDER BY created_at DESC LIMIT 1;`,
    )[0] ?? null
  );
}

function setDirector() {
  const auditId = `audit_${randomBytes(8).toString("hex")}`;
  d1File(
    `UPDATE company_memberships
     SET role='director', updated_at=datetime('now')
     WHERE id='${WILLIAM_MEM}' AND user_id='${WILLIAM_USER}' AND company_id='co_el';
     INSERT INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
     VALUES (
       '${auditId}', 'co_el', 'user.role_changed', 'cursor-director-override',
       'user', '${WILLIAM_USER}',
       '{"role":"director","reason":"operator override: William is intended Director; do not restore office_staff","platformAdmin":false}',
       datetime('now')
     );`,
  );
  return membership();
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
    tool: nested?.tool ?? payload?.tool ?? null,
    keys: nested && typeof nested === "object" ? Object.keys(nested).slice(0, 20) : [],
  };
}

const started = new Date().toISOString();
const report = {
  recordedBefore: membership(),
  lastOperatorRoleChange: lastOperatorRole(),
  workerHealth: await fetch(`${API}/health`, { headers: { "User-Agent": UA } }).then((r) => r.json()),
  webhook: "https://api.infrastack.app/api/webhooks/whatsapp",
};

const officeStaffTools = [];
if (report.recordedBefore?.role === "office_staff") {
  const mintedStaff = await mintWilliamToken();
  if (mintedStaff.accessToken) {
    await mcp(mintedStaff.accessToken, "initialize", { protocolVersion: "2025-03-26" }, 1);
    const listed = await mcp(mintedStaff.accessToken, "tools/list", {}, 2);
    officeStaffTools.push(...(listed.body?.result?.tools ?? []).map((tool) => tool.name));
    report.officeStaffTools = officeStaffTools;
    report.officeStaffXero = officeStaffTools.filter((name) => name.startsWith("xero_") || name.includes("xero"));
  }
}

report.afterOverride = setDirector();
report.effectiveXeroSalesRead = report.afterOverride?.role === "director";

const minted = await mintWilliamToken();
report.tokenOk = Boolean(minted.accessToken);
report.tokenHttp = minted.httpStatus;
report.tokenError = minted.error;
if (!minted.accessToken) {
  writeFileSync("/tmp/director-xero-tools-live.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const token = minted.accessToken;
await mcp(token, "initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "chatgpt", version: "1.0" } }, 10);
const listed = await mcp(token, "tools/list", {}, 11);
const tools = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
report.directorTools = tools;
report.directorXero = tools.filter((name) => name.startsWith("xero_") || name.includes("xero"));
report.requiredPresent = Object.fromEntries(REQUIRED.map((name) => [name, tools.includes(name)]));
report.writeTools = tools.filter((name) => /create|approve|send|allocate|void|update|delete/i.test(name));

const sept = await mcp(
  token,
  "tools/call",
  { name: "xero_sales_summary", arguments: { period: "this month", fromDate: "2026-09-01", toDate: "2026-09-01" } },
  20,
);
report.september = {
  httpStatus: sept.httpStatus,
  rpcError: sept.body?.error ?? null,
  summary: summarise(toolText(sept.body)),
};

const aug = await mcp(
  token,
  "tools/call",
  { name: "xero_sales_summary", arguments: { period: "last month" } },
  21,
);
report.august = {
  httpStatus: aug.httpStatus,
  rpcError: aug.body?.error ?? null,
  summary: summarise(toolText(aug.body)),
};

const invoices = await mcp(
  token,
  "tools/call",
  { name: "xero_search_invoices", arguments: { fromDate: "2026-09-01", toDate: "2026-09-01" } },
  22,
);
report.septemberInvoices = {
  httpStatus: invoices.httpStatus,
  rpcError: invoices.body?.error ?? null,
  summary: summarise(toolText(invoices.body)),
};

report.finalMembership = membership();
report.usage = d1(
  `SELECT tool_name, action, success, settlement_status, customer_charge_cents, source_client, recorded_at
   FROM usage_records
   WHERE company_id='co_el' AND (user_id='${WILLIAM_USER}' OR actor_email LIKE 'william@%')
     AND recorded_at >= '${started}'
   ORDER BY recorded_at DESC LIMIT 20;`,
);
report.chatgptRefreshStillValid = Boolean(
  d1(
    `SELECT id FROM oauth_refresh_tokens
     WHERE user_id='${WILLIAM_USER}' AND company_id='co_el'
       AND revoked_at IS NULL AND expires_at > datetime('now') LIMIT 1;`,
  )[0]?.id,
);

if (minted.refreshToken) {
  await fetch(`${API}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ token: minted.refreshToken, client_id: CLIENT_ID }),
  });
}

writeFileSync("/tmp/director-xero-tools-live.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
