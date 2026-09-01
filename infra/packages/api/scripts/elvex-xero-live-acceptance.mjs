#!/usr/bin/env node
/** Temporary William finance_team Xero READ acceptance. Restores office_staff. Never prints tokens. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.INFRA_API_BASE ?? "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1File(sql) {
  const sqlFile = join(apiDir, ".tmp-elvex-xero-accept.sql");
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

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function pkceS256(verifier) {
  return b64url(createHash("sha256").update(verifier).digest());
}

function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function setRole(role) {
  d1File(
    `UPDATE company_memberships SET role='${role}' WHERE id='${WILLIAM_MEM}' AND company_id='co_el';`,
  );
  return d1(
    `SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`,
  )[0]?.role;
}

async function mintWilliamToken() {
  const verifier = randomUrlSafe(32);
  const challenge = pkceS256(verifier);
  const code = randomUrlSafe(32);
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
    hasAccess: typeof body.access_token === "string",
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    accessToken: body.access_token ?? null,
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
  return { httpStatus: res.status, contentType: res.headers.get("content-type"), body };
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

function pickFigure(payload) {
  const nested =
    payload?.result && typeof payload.result === "object" ? payload.result : payload;
  const summary = nested?.summary && typeof nested.summary === "object" ? nested.summary : {};
  const invoices = nested?.invoices ?? nested?.Invoices ?? nested?.transactions ?? [];
  return {
    totalSales:
      summary.totalSales ??
      summary.total ??
      nested?.totalSales ??
      nested?.sales ??
      nested?.revenue ??
      nested?.total ??
      null,
    invoiceCount:
      summary.transactionCount ??
      nested?.invoiceCount ??
      (Array.isArray(invoices) ? invoices.length : null),
    currency: summary.currencyCode ?? nested?.currencyCode ?? nested?.currency ?? null,
    firstInvoice:
      invoices?.[0]?.InvoiceNumber ??
      invoices?.[0]?.invoiceNumber ??
      nested?.invoice?.InvoiceNumber ??
      nested?.invoice?.invoiceNumber ??
      null,
    topCustomer:
      nested?.customers?.[0]?.name ??
      nested?.customers?.[0]?.Name ??
      nested?.top_customers?.[0]?.name ??
      nested?.topCustomers?.[0]?.name ??
      null,
    source: nested?.source ?? payload?.source ?? null,
    elToolName: nested?.elToolName ?? payload?.elToolName ?? null,
    fromDate: nested?.fromDate ?? summary.fromDate ?? null,
    toDate: nested?.toDate ?? summary.toDate ?? null,
    snippet:
      typeof nested?.text === "string"
        ? nested.text.slice(0, 240)
        : typeof payload?.text === "string"
          ? payload.text.slice(0, 240)
          : null,
  };
}

const report = {
  beforeRole: d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role,
  financeRole: null,
  tokenOk: false,
  toolsList: [],
  xeroTools: [],
  reads: {},
  officeStaff: {},
  usage: [],
  oauthStillValid: false,
  restoredRole: null,
};

try {
  report.financeRole = setRole("finance_team");
  const minted = await mintWilliamToken();
  report.tokenOk = minted.hasAccess;
  if (!minted.hasAccess) {
    throw new Error(`token_mint_failed ${minted.httpStatus} ${minted.error}`);
  }
  const token = minted.accessToken;

  await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 1);
  const listed = await mcp(token, "tools/list", {}, 2);
  report.toolsList = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
  report.xeroTools = report.toolsList.filter(
    (name) => name.startsWith("xero_") || name.includes("xero"),
  );

  const calls = [
    ["sales_today", "xero_sales_summary", { period: "today" }],
    ["sales_this_month", "xero_sales_summary", { period: "this month" }],
    ["invoices_today", "xero_search_invoices", { period: "today" }],
    ["outstanding", "xero_search_invoices", { unpaidOnly: true, period: "this year" }],
    ["overdue", "xero_list_overdue_invoices", {}],
    ["top_customers", "xero_top_customers", { period: "this month", limit: 5 }],
  ];

  for (const [key, name, args] of calls) {
    const result = await mcp(token, "tools/call", { name, arguments: args }, key);
    const payload = toolText(result.body);
    report.reads[key] = {
      httpStatus: result.httpStatus,
      rpcError: result.body?.error ?? null,
      figure: pickFigure(payload),
      keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
      rawError: result.body?.error ?? (payload && payload.error) ?? null,
      preview: result.body?.parseError ?? null,
    };
    if (key === "outstanding" && report.reads[key].figure.firstInvoice) {
      const inv = report.reads[key].figure.firstInvoice;
      const lookup = await mcp(
        token,
        "tools/call",
        { name: "xero_get_invoice", arguments: { invoiceNumber: inv } },
        "lookup",
      );
      report.reads.invoice_lookup = {
        invoiceNumber: inv,
        httpStatus: lookup.httpStatus,
        rpcError: lookup.body?.error ?? null,
        figure: pickFigure(toolText(lookup.body)),
      };
    }
  }

  if (minted.refreshToken) {
    await fetch(`${API}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: new URLSearchParams({ token: minted.refreshToken, client_id: CLIENT_ID }),
    });
  }
} catch (error) {
  report.liveError = error instanceof Error ? error.message : String(error);
} finally {
  report.restoredRole = setRole("office_staff");
}

try {
  const mintedDenied = await mintWilliamToken();
  report.officeStaff.tokenOk = mintedDenied.hasAccess;
  if (mintedDenied.hasAccess) {
    const token = mintedDenied.accessToken;
    await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 10);
    const listed = await mcp(token, "tools/list", {}, 11);
    const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
    report.officeStaff.xeroTools = names.filter(
      (name) => name.startsWith("xero_") || name.includes("xero"),
    );
    const denied = await mcp(
      token,
      "tools/call",
      { name: "xero_sales_summary", arguments: { period: "today" } },
      12,
    );
    report.officeStaff.call = {
      httpStatus: denied.httpStatus,
      error: denied.body?.error ?? null,
      text: toolText(denied.body),
    };
    if (mintedDenied.refreshToken) {
      await fetch(`${API}/oauth/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
        },
        body: new URLSearchParams({ token: mintedDenied.refreshToken, client_id: CLIENT_ID }),
      });
    }
  }
} catch (error) {
  report.officeStaff.error = error instanceof Error ? error.message : String(error);
}

report.finalRole = d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role;
report.oauthStillValid = Boolean(
  d1(
    `SELECT id FROM oauth_refresh_tokens WHERE user_id='${WILLIAM_USER}' AND company_id='co_el' AND revoked_at IS NULL AND expires_at > datetime('now') LIMIT 1;`,
  )[0]?.id,
);
report.usage = d1(
  `SELECT tool_name, action, success, settlement_status, customer_charge_cents, source_client, recorded_at
   FROM usage_records
   WHERE company_id='co_el' AND actor_email LIKE 'william@%'
   ORDER BY recorded_at DESC LIMIT 12;`,
);

console.log(JSON.stringify(report, null, 2));
