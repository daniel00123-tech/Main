#!/usr/bin/env node
/** CMD11 live UAT — prefix INFRA-CMD11-UAT-20260827-UPDATE-* */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const COMPANY = "co_caddington";
const REF = `INFRA-CMD11-UAT-20260827-UPDATE-${randomBytes(2).toString("hex")}`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const svcId = `svc_cmd11_${randomBytes(3).toString("hex")}`;
let rpcId = 1;

const SCOPES = JSON.stringify([
  "xero.invoices.get", "xero.invoices.read", "xero.contacts.read",
  "xero.action.plan", "xero.action.confirm", "xero.action.execute", "xero.action.read",
]);

function runSql(sql) {
  const f = join(apiDir, ".tmp-cmd11.sql");
  writeFileSync(f, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", f], { cwd: apiDir, stdio: "pipe" });
  unlinkSync(f);
}

runSql(`INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${svcId}', '${COMPANY}', 'cmd11 uat', 'cmd11', 'active', NULL, 'chatgpt', '${createHash("sha256").update(token).digest("hex")}', '${token.slice(0,12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`);

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
let walletBefore = null;

try {
  await mcp("initialize", { protocolVersion: "2025-03-26" });

  const plan1 = await mcp("plan_xero_draft_invoice", {
    contactName: "ELVEX PROPERTY SERVICES LTD",
    reference: `${REF}-INV`,
    taxTreatment: "No VAT",
    lineItems: [{ description: "CMD11 update UAT", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
  });
  await mcp("confirm_action_plan", { planId: plan1.planId, confirmationToken: plan1.confirmationToken });
  const ex1 = await mcp("execute_action_plan", { planId: plan1.planId });
  const invId = ex1.executionResult?.xeroResourceId ?? ex1.executionResult?.results?.xeroInvoiceId;
  results.push({ test: "1_create_draft", pass: ex1.executionResult?.ok === true, ref: REF });
  if (invId) created.push({ type: "invoice", id: invId, ref: `${REF}-INV`, status: "DRAFT" });

  await sleep(2500);

  if (invId) {
    const planU1 = await mcp("plan_xero_update_draft_invoice", {
      invoiceId: invId,
      reference: `${REF}-INV-REF-UPDATED`,
    });
    const validU1 = planU1.targets?.[0]?.validation === "valid";
    if (validU1) {
      await mcp("confirm_action_plan", { planId: planU1.planId, confirmationToken: planU1.confirmationToken });
      const exU1 = await mcp("execute_action_plan", { planId: planU1.planId });
      results.push({ test: "2_update_reference", pass: exU1.executionResult?.ok === true });
    } else {
      results.push({ test: "2_update_reference", pass: false, detail: planU1.summary });
    }

    await sleep(2500);

    const planU2 = await mcp("plan_xero_update_draft_invoice", {
      invoiceId: invId,
      lineItems: [{ description: "CMD11 desc updated", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
    });
    const validU2 = planU2.targets?.[0]?.validation === "valid";
    if (validU2) {
      await mcp("confirm_action_plan", { planId: planU2.planId, confirmationToken: planU2.confirmationToken });
      const exU2 = await mcp("execute_action_plan", { planId: planU2.planId });
      results.push({ test: "3_update_description", pass: exU2.executionResult?.ok === true });
    } else {
      results.push({ test: "3_update_description", pass: false, detail: planU2.summary });
    }

    await sleep(2500);

    const manifest = await mcp("list_xero_test_artefacts", { prefix: "INFRA-CMD11-UAT-", limit: 20 });
    const matches = (manifest.artefacts ?? []).filter((a) => a.reference?.startsWith("INFRA-CMD11-UAT-20260827-UPDATE"));
    const dupes = matches.length;
    results.push({ test: "4_no_duplicate", pass: dupes <= 1, count: dupes });
    results.push({ test: "5_artefact_manifest", pass: Array.isArray(manifest.artefacts), count: manifest.artefacts?.length ?? 0 });
  }

  console.log(JSON.stringify({ results, created, passCount: results.filter((r) => r.pass).length, walletBefore }, null, 2));
} finally {
  runSql(`DELETE FROM service_identities WHERE id='${svcId}';`);
}
