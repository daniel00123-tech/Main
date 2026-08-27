#!/usr/bin/env node
/**
 * Production non-mutating dry-run for Elvex £1 draft invoice plan.
 * Creates plan only — does NOT confirm or execute.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const CHATGPT_SCOPES = JSON.stringify([
  "system.health",
  "knowledge.search",
  "knowledge.read",
  "xero.organisation.read",
  "xero.contacts.search",
  "xero.contacts.read",
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.execute",
  "xero.action.cancel",
  "xero.action.list",
]);

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const sqlFile = join(apiDir, ".tmp-dry-run.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP dry-run', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${CHATGPT_SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function mcpCall(method, params, rpcId) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
}

function toolPayload(body) {
  const text = body?.result?.content?.find((p) => p.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

await mcpCall("initialize", { protocolVersion: "2025-03-26" }, 1);
const tools = await mcpCall("tools/list", {}, 2);
const toolNames = tools.body?.result?.tools?.map((t) => t.name) ?? [];

const planCall = await mcpCall(
  "tools/call",
  {
    name: "plan_xero_draft_invoice",
    arguments: {
      contactName: "ELVEX PROPERTY SERVICES LTD",
      lineItems: [{ description: "test", quantity: 1, unitAmount: 1, accountCode: "200" }],
      reference: "123",
      invoiceDate: "2026-08-25",
      dueDate: "2026-08-26",
      taxTreatment: "No VAT",
    },
  },
  3,
);

const plan = toolPayload(planCall.body);
let dryRun = null;
if (plan?.planId) {
  const dry = await mcpCall("tools/call", { name: "dry_run_action_plan", arguments: { planId: plan.planId } }, 4);
  dryRun = toolPayload(dry.body);
}

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id='${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      tools: {
        count: toolNames.length,
        hasExecute: toolNames.includes("execute_action_plan"),
        hasPlan: toolNames.includes("plan_xero_draft_invoice"),
      },
      plan: plan
        ? {
            planId: plan.planId,
            status: plan.status,
            review: plan.review,
            workflow: plan.workflow,
            permission: plan.permission,
          }
        : planCall,
      dryRun,
    },
    null,
    2,
  ),
);
