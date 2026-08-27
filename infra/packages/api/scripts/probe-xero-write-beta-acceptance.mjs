#!/usr/bin/env node
/** Minimal Xero WRITE beta live acceptance — max 2 draft creates, optional 1 approve */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const COMPANY = "co_caddington";
const REF_PREFIX = "INFRA-BETA-WRITE-20260827";
const RUN_SUFFIX = randomBytes(2).toString("hex");
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const svcId = `svc_beta_${randomBytes(3).toString("hex")}`;
let rpcId = 1;

const SCOPES = JSON.stringify([
  "xero.invoices.get", "xero.invoices.read", "xero.contacts.read",
  "xero.action.plan", "xero.action.confirm", "xero.action.execute",
]);

function runSql(sql) {
  const f = join(apiDir, ".tmp-beta.sql");
  writeFileSync(f, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", f], { cwd: apiDir, stdio: "pipe" });
  unlinkSync(f);
}

runSql(`INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${svcId}', '${COMPANY}', 'beta probe', 'beta', 'active', NULL, 'chatgpt', '${createHash("sha256").update(token).digest("hex")}', '${token.slice(0,12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`);

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

async function execRead(tool, args) {
  const r = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: COMPANY, toolName: tool, arguments: args }),
  });
  return { status: r.status, body: await r.json() };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const created = [];
const results = [];

try {
  await mcp("initialize", { protocolVersion: "2025-03-26" });

  // Bypass still blocked
  const bypassRes = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: COMPANY, toolName: "xero_approve_invoice", arguments: { invoiceId: "x" } }),
  });
  const bypass = await bypassRes.json();
  results.push({
    test: "direct_bypass",
    pass: bypassRes.status === 403 && (bypass.code === "ACTION_ENGINE_REQUIRED" || String(bypass.error ?? "").includes("Action Engine")),
    status: bypassRes.status,
    code: bypass.code,
  });

  // Beta draft 1
  const plan1 = await mcp("plan_xero_draft_invoice", {
    contactName: "ELVEX PROPERTY SERVICES LTD",
    reference: `${REF_PREFIX}-DRAFT-${RUN_SUFFIX}`,
    taxTreatment: "No VAT",
    lineItems: [{ description: "INFRA Beta Test 01", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
  });
  const conf1 = await mcp("confirm_action_plan", { planId: plan1.planId, confirmationToken: plan1.confirmationToken });
  const ex1 = await mcp("execute_action_plan", { planId: plan1.planId });
  const id1 = ex1.executionResult?.xeroResourceId;
  let rb1 = null;
  if (id1) rb1 = await execRead("xero_get_invoice", { invoiceId: id1 });
  const pass1 = ex1.executionResult?.ok && rb1?.body?.result?.invoice?.Status === "DRAFT";
  results.push({ test: "beta_draft_01", pass: pass1, humanSummary: ex1.humanSummary, invoiceNumber: ex1.executionResult?.humanReference });
  if (pass1) created.push({ ref: `${REF_PREFIX}-DRAFT-${RUN_SUFFIX}`, ...ex1.executionResult });

  await sleep(3000);

  // Approve beta draft 1 (BETA_ENABLED gate — should work in beta if gate allows)
  if (id1) {
    const planA = await mcp("plan_xero_approve_invoice", { invoiceId: id1 });
    if (planA.planId && planA.targets?.[0]?.validation === "valid") {
      await mcp("confirm_action_plan", { planId: planA.planId, confirmationToken: planA.confirmationToken });
      await sleep(2000);
      const exA = await mcp("execute_action_plan", { planId: planA.planId });
      const rbA = await execRead("xero_get_invoice", { invoiceId: id1 });
      results.push({
        test: "beta_approve_01",
        pass: exA.executionResult?.ok && rbA.body?.result?.invoice?.Status === "AUTHORISED",
        humanSummary: exA.humanSummary,
        status: rbA.body?.result?.invoice?.Status,
        error: exA.executionResult?.error,
        code: exA.executionResult?.code,
        planStatus: exA.status,
      });
    } else {
      results.push({ test: "beta_approve_01", pass: false, planValidation: planA.targets?.[0]?.validation, detail: planA.summary });
    }
  }

  await sleep(3000);

  // Beta draft bill (max 1)
  const planB = await mcp("plan_xero_draft_bill", {
    contactName: "ELVEX PROPERTY SERVICES LTD",
    reference: `${REF_PREFIX}-BILL-${RUN_SUFFIX}`,
    taxTreatment: "No VAT",
    lineItems: [{ description: "INFRA Beta Supplier Bill Test", quantity: 1, unitAmount: 0.01 }],
  });
  if (planB.planId && planB.targets?.[0]?.validation === "valid") {
    await mcp("confirm_action_plan", { planId: planB.planId, confirmationToken: planB.confirmationToken });
    const exB = await mcp("execute_action_plan", { planId: planB.planId });
    results.push({
      test: "beta_draft_bill",
      pass: exB.executionResult?.ok === true,
      humanSummary: exB.humanSummary,
      error: exB.executionResult?.error,
      code: exB.executionResult?.code,
    });
    if (exB.executionResult?.ok) created.push({ ref: `${REF_PREFIX}-BILL-${RUN_SUFFIX}`, ...exB.executionResult });
  } else {
    results.push({ test: "beta_draft_bill", pass: false, error: planB.summary ?? planB.error, validation: planB.targets?.[0]?.validation });
  }

  console.log(JSON.stringify({ results, created, passCount: results.filter((r) => r.pass).length }, null, 2));
} finally {
  runSql(`DELETE FROM service_identities WHERE id='${svcId}';`);
}
