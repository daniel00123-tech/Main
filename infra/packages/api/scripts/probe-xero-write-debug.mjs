#!/usr/bin/env node
/** Debug write alpha failures — read back created invoices and retry failed tests */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const svcId = `svc_dbg_w_${randomBytes(3).toString("hex")}`;

const SCOPES = JSON.stringify([
  "xero.invoices.get","xero.invoices.search","xero.invoices.read",
  "xero.action.plan","xero.action.confirm","xero.action.execute",
  "xero.contacts.read","xero.accounts.read",
]);

function runSql(sql) {
  const f = join(apiDir, ".tmp-dbgw.sql");
  writeFileSync(f, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", f], { cwd: apiDir, stdio: "pipe" });
  unlinkSync(f);
}

runSql(`INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${svcId}', 'co_caddington', 'dbg', 'dbg', 'active', NULL, 'chatgpt', '${createHash("sha256").update(token).digest("hex")}', '${token.slice(0,12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`);

async function execRead(tool, args) {
  const r = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: "co_caddington", toolName: tool, arguments: args }),
  });
  return { status: r.status, body: await r.json() };
}

async function mcpCall(name, args) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await r.json();
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : body;
}

const ids = [
  "70699a6c-7da6-4833-a344-c12f6cc47afc",
  "c3bf4cf7-519a-42c5-afae-657e6893a272",
];

for (const id of ids) {
  const rb = await execRead("xero_get_invoice", { invoiceId: id });
  const inv = rb.body?.result?.invoice;
  console.log("---", id);
  console.log(JSON.stringify({
    status: rb.status,
    hasInvoice: Boolean(inv),
    keys: inv ? Object.keys(inv) : [],
    Status: inv?.Status,
    DueDate: inv?.DueDate,
    DueDateString: inv?.DueDateString,
    Reference: inv?.Reference,
    LineItems: inv?.LineItems?.length,
  }, null, 2));
}

const bypass = await fetch(`${API}/api/gateway/v1/execute`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    companyId: "co_caddington",
    toolName: "xero_create_draft_invoice",
    arguments: { contactId: "x", lineItems: [] },
  }),
}).then((r) => r.json());
console.log("BYPASS:", JSON.stringify(bypass, null, 2));

// Retry test 9 flow
const plan = await mcpCall("plan_xero_draft_invoice", {
  contactName: "ELVEX PROPERTY SERVICES LTD",
  reference: "INFRA-ALPHA-WRITE-09-20260827-RETRY",
  dueDate: "2026-08-28",
  invoiceDate: "2026-08-27",
  taxTreatment: "No VAT",
  lineItems: [{ description: "Test 9 retry", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
});
console.log("PLAN9:", plan?.planId, plan?.targets?.[0]?.validation, plan?.summary);
if (plan?.planId && plan?.confirmationToken) {
  const conf = await mcpCall("confirm_action_plan", { planId: plan.planId, confirmationToken: plan.confirmationToken });
  console.log("CONF9:", conf?.confirmationStatus, conf?.status);
  const ex = await mcpCall("execute_action_plan", { planId: plan.planId });
  console.log("EXEC9:", ex?.executionResult);
}

runSql(`DELETE FROM service_identities WHERE id='${svcId}';`);
