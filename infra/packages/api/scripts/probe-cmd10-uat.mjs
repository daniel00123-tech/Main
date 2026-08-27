#!/usr/bin/env node
/** CMD10 minimal live UAT — prefix INFRA-CMD10-UAT-20260827- */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const COMPANY = "co_caddington";
const REF = `INFRA-CMD10-UAT-20260827-${randomBytes(2).toString("hex")}`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const svcId = `svc_cmd10_${randomBytes(3).toString("hex")}`;
let rpcId = 1;

const SCOPES = JSON.stringify([
  "xero.invoices.get", "xero.invoices.read", "xero.contacts.read",
  "xero.action.plan", "xero.action.confirm", "xero.action.execute", "xero.action.read",
]);

function runSql(sql) {
  const f = join(apiDir, ".tmp-cmd10.sql");
  writeFileSync(f, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", f], { cwd: apiDir, stdio: "pipe" });
  unlinkSync(f);
}

runSql(`INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${svcId}', '${COMPANY}', 'cmd10 uat', 'cmd10', 'active', NULL, 'chatgpt', '${createHash("sha256").update(token).digest("hex")}', '${token.slice(0,12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`);

async function mcp(name, args) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await r.json();
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : body;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const results = [];
const created = [];

try {
  await mcp("initialize", { protocolVersion: "2025-03-26" });

  const plan1 = await mcp("plan_xero_draft_invoice", {
    contactName: "ELVEX PROPERTY SERVICES LTD",
    reference: `${REF}-INV`,
    taxTreatment: "No VAT",
    lineItems: [{ description: "CMD10 UAT", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
  });
  await mcp("confirm_action_plan", { planId: plan1.planId, confirmationToken: plan1.confirmationToken });
  const ex1 = await mcp("execute_action_plan", { planId: plan1.planId });
  const invId = ex1.executionResult?.xeroResourceId;
  results.push({ test: "draft_invoice", pass: ex1.executionResult?.ok === true, ref: REF });
  if (invId) created.push({ type: "invoice", id: invId, ref: `${REF}-INV` });

  await sleep(2500);

  if (invId) {
    const planU = await mcp("plan_xero_update_draft_invoice", {
      invoiceId: invId,
      reference: `${REF}-INV-UPDATED`,
    });
    const validUpdate = planU.targets?.[0]?.validation === "valid";
    if (validUpdate) {
      await mcp("confirm_action_plan", { planId: planU.planId, confirmationToken: planU.confirmationToken });
      const exU = await mcp("execute_action_plan", { planId: planU.planId });
      results.push({ test: "update_draft", pass: exU.executionResult?.ok === true, code: exU.executionResult?.code });
    } else {
      results.push({ test: "update_draft", pass: false, gate: planU.summary });
    }
    await sleep(2500);
    const planA = await mcp("plan_xero_approve_invoice", { invoiceId: invId });
    if (planA.targets?.[0]?.validation === "valid") {
      await mcp("confirm_action_plan", { planId: planA.planId, confirmationToken: planA.confirmationToken });
      const exA = await mcp("execute_action_plan", { planId: planA.planId });
      results.push({ test: "approve_invoice", pass: exA.executionResult?.ok === true });
    }
  }

  await sleep(2500);
  const manifest = await mcp("list_xero_test_artefacts", { prefix: "INFRA-CMD10-UAT-", limit: 20 });
  results.push({ test: "test_artefact_manifest", pass: Array.isArray(manifest.artefacts), count: manifest.artefacts?.length ?? 0 });

  console.log(JSON.stringify({ results, created, passCount: results.filter((r) => r.pass).length }, null, 2));
} finally {
  runSql(`DELETE FROM service_identities WHERE id='${svcId}';`);
}
