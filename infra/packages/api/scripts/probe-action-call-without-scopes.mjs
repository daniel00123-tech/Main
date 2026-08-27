#!/usr/bin/env node
/** Test action tool call with exact production scopes (no xero.action.*). */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const PRODUCTION_SCOPES = [
  "knowledge.search",
  "knowledge.read",
  "system.health",
  "xero.organisation.read",
  "xero.contacts.read",
  "xero.contacts.search",
  "xero.invoices.read",
  "xero.invoices.search",
  "xero.invoices.get",
  "xero.payments.read",
  "xero.accounts.read",
  "xero.bank_transactions.read",
  "xero.reports.pnl.read",
  "xero.reports.balance_sheet.read",
  "xero.reports.aged.read",
  "xero.sales.summary",
  "xero.top_customers",
  "xero.health",
  "xero.token_refresh",
];

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");

const sqlFile = join(apiDir, ".tmp-action-call.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP action call probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${JSON.stringify(PRODUCTION_SCOPES).replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function mcp(method, params, rpcId) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

await mcp("initialize", { protocolVersion: "2025-03-26" }, 1);
const plan = await mcp(
  "tools/call",
  {
    name: "plan_xero_draft_invoice",
    arguments: {
      lineItems: [{ description: "probe", quantity: 1, unitAmount: 1 }],
      reference: "PROBE-NO-MUTATION",
    },
  },
  2,
);

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

console.log(JSON.stringify({ planCall: { status: plan.status, error: plan.body?.error ?? null, hasPlanId: Boolean(plan.body?.result?.content?.[0]?.text?.includes?.("planId")) } }, null, 2));
