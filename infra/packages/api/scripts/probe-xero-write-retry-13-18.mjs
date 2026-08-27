#!/usr/bin/env node
/** Retry specific write alpha tests after rate-limit cooldown */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const COMPANY = "co_caddington";
const DATE_STAMP = "20260827";
const TODAY = "2026-08-27";
const TOMORROW = "2026-08-28";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const svcId = `svc_retry_${randomBytes(3).toString("hex")}`;
let rpcId = 1;

const SCOPES = JSON.stringify([
  "xero.contacts.read","xero.contacts.search","xero.invoices.get",
  "xero.action.plan","xero.action.confirm","xero.action.execute",
]);

function runSql(sql) {
  const f = join(apiDir, ".tmp-retry.sql");
  writeFileSync(f, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", f], { cwd: apiDir, stdio: "pipe" });
  unlinkSync(f);
}

runSql(`INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${svcId}', '${COMPANY}', 'retry', 'retry', 'active', NULL, 'chatgpt', '${createHash("sha256").update(token).digest("hex")}', '${token.slice(0,12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`);

async function mcpCall(name, args) {
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

function ref(n) {
  return `INFRA-ALPHA-WRITE-${String(n).padStart(2, "0")}-${DATE_STAMP}`;
}

async function fullFlow(args, idempotencyKey) {
  const plan = await mcpCall("plan_xero_draft_invoice", { ...args, ...(idempotencyKey ? { idempotencyKey } : {}) });
  console.log("PLAN", plan?.planId, plan?.targets?.[0]?.validation, plan?.targets?.[0]?.validationDetail);
  if (!plan?.planId || plan?.targets?.[0]?.validation !== "valid") return { ok: false, plan };
  await sleep(1500);
  const conf = await mcpCall("confirm_action_plan", { planId: plan.planId, confirmationToken: plan.confirmationToken });
  console.log("CONF", conf?.confirmationStatus);
  await sleep(1500);
  const ex = await mcpCall("execute_action_plan", { planId: plan.planId });
  console.log("EXEC", ex?.executionResult);
  const invoiceId = ex?.executionResult?.xeroResourceId;
  let readback = null;
  if (invoiceId) {
    await sleep(1000);
    const rb = await execRead("xero_get_invoice", { invoiceId });
    readback = rb.body?.result?.invoice;
  }
  return { ok: ex?.executionResult?.ok === true, plan, exec: ex?.executionResult, readback };
}

try {
  console.log("=== TEST 13 contact by name ===");
  const t13 = await fullFlow({
    contactName: "ELVEX PROPERTY SERVICES LTD",
    reference: ref(13),
    invoiceDate: TODAY,
    dueDate: TOMORROW,
    taxTreatment: "No VAT",
    lineItems: [{ description: "INFRA Alpha Test 13", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
  });
  const contactId = t13.readback?.Contact?.ContactID;
  console.log("T13 contactId", contactId, "expected cc7c104a-c059-43b1-8c6b-8b5750a5321b");

  await sleep(5000);

  console.log("=== TEST 14 contact typo ===");
  const t14plan = await mcpCall("plan_xero_draft_invoice", {
    contactName: "Elvex Property Servces Ltd",
    reference: ref(14),
    lineItems: [{ description: "INFRA Alpha Test 14", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
    taxTreatment: "No VAT",
  });
  console.log("T14", t14plan?.targets?.[0]?.validation, t14plan?.targets?.[0]?.validationDetail);

  await sleep(5000);

  console.log("=== TEST 18 idempotency ===");
  const idem = `alpha-write-18-retry-${DATE_STAMP}`;
  const args = {
    contactName: "ELVEX PROPERTY SERVICES LTD",
    reference: ref(18),
    taxTreatment: "No VAT",
    lineItems: [{ description: "INFRA Alpha Test 18", quantity: 1, unitAmount: 0.01, accountCode: "200" }],
  };
  const first = await fullFlow({ ...args, idempotencyKey: idem });
  await sleep(2000);
  const plan2 = await mcpCall("plan_xero_draft_invoice", { ...args, idempotencyKey: idem });
  console.log("T18 samePlan", plan2?.planId === first.plan?.planId, first.plan?.planId, plan2?.planId);
} finally {
  runSql(`DELETE FROM service_identities WHERE id='${svcId}';`);
}
