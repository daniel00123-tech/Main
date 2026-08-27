#!/usr/bin/env node
/** Reproduce tools/list with exact production infra_1HS3Nn scopes before/after fix. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlFile = join(apiDir, ".tmp-exact-scopes.sql");

const PRODUCTION_SCOPES_BEFORE = [
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

const PRODUCTION_SCOPES_AFTER = [
  ...PRODUCTION_SCOPES_BEFORE,
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.cancel",
  "xero.action.list",
];

const actionTools = [
  "get_action_plan",
  "confirm_action_plan",
  "cancel_action_plan",
  "list_pending_actions",
  "dry_run_action_plan",
  "plan_xero_credit_invoices",
  "plan_xero_draft_invoice",
  "plan_xero_remittance_allocation",
];

async function probeWithScopes(scopesList, label) {
  const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
  const id = `svc_probe_${randomBytes(8).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");

  writeFileSync(
    sqlFile,
    `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP exact scope probe ${label}', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${JSON.stringify(scopesList).replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
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
  const list = await mcp("tools/list", {}, 2);
  const tools = (list.body?.result?.tools ?? []).map((t) => t.name);

  writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });

  return tools;
}

const beforeFix = await probeWithScopes(PRODUCTION_SCOPES_BEFORE, "before");
const afterFix = await probeWithScopes(PRODUCTION_SCOPES_AFTER, "after");
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      mcpUrl: `${API}/api/gateway/v1/mcp`,
      productionIdentity: "infra_1HS3Nn (svc_c574f59b-d8eb-493e-917b-ee4c223e37f1)",
      scopesBeforeFix: PRODUCTION_SCOPES_BEFORE,
      scopesAfterFix: PRODUCTION_SCOPES_AFTER,
      toolsListBeforeFix: {
        totalTools: beforeFix.length,
        toolNames: beforeFix,
        actionToolsPresent: Object.fromEntries(actionTools.map((n) => [n, beforeFix.includes(n)])),
        writeToolHidden: !beforeFix.includes("xero_create_draft_invoice"),
      },
      toolsListAfterFix: {
        totalTools: afterFix.length,
        toolNames: afterFix,
        actionToolsPresent: Object.fromEntries(actionTools.map((n) => [n, afterFix.includes(n)])),
        writeToolHidden: !afterFix.includes("xero_create_draft_invoice"),
      },
    },
    null,
    2,
  ),
);
