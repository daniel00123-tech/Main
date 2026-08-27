#!/usr/bin/env node
/**
 * Xero WRITE Alpha — 20 controlled live tests against Caddington Holdings.
 * DRAFT ACCREC invoices only via Action Engine (plan → confirm → execute).
 * References: INFRA-ALPHA-WRITE-XX-20260827
 */
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
const FROM_TEST = Number(process.env.FROM_TEST ?? process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] ?? 1);
const WRITE_DELAY_MS = Number(process.env.WRITE_DELAY_MS ?? 2500);
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCOPES = JSON.stringify([
  "system.health",
  "knowledge.search",
  "knowledge.read",
  "xero.organisation.read",
  "xero.contacts.search",
  "xero.contacts.read",
  "xero.accounts.read",
  "xero.invoices.read",
  "xero.invoices.search",
  "xero.invoices.get",
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.execute",
  "xero.action.cancel",
  "xero.action.list",
]);

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const svcId = `svc_write_alpha_${randomBytes(4).toString("hex")}`;
let rpcId = 1;

function runSql(sql) {
  const f = join(apiDir, ".tmp-write-alpha.sql");
  writeFileSync(f, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", f], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(f);
}

function setupIdentity() {
  runSql(
    `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${svcId}', '${COMPANY}', 'WRITE alpha probe', 'auto cleanup', 'active', NULL, 'chatgpt', '${createHash("sha256").update(token).digest("hex")}', '${token.slice(0, 12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
  );
}

function cleanupIdentity() {
  runSql(`DELETE FROM service_identities WHERE id='${svcId}';`);
}

async function mcpCall(method, params) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return { httpStatus: res.status, body: await res.json().catch(() => ({})) };
}

function toolPayload(body) {
  const text = body?.result?.content?.find((p) => p.type === "text")?.text;
  if (!text) return body?.result ?? body?.error ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function execRead(toolName, args = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: COMPANY, toolName, arguments: args, sourceClient: "write-alpha" }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function execGatewayWrite(toolName, args = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: COMPANY, toolName, arguments: args, sourceClient: "write-alpha-bypass" }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function approxEqual(a, b, epsilon = 0.001) {
  return Math.abs(Number(a ?? 0) - Number(b ?? 0)) < epsilon;
}

function bypassBlocked(body, status) {
  return (
    status === 403 &&
    (body?.code === "ACTION_ENGINE_REQUIRED" ||
      String(body?.error ?? "").includes("Action Engine"))
  );
}

function normDate(v) {
  if (!v) return null;
  const s = String(v);
  const m = /^\/Date\((\d+)/.exec(s);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

function readInvoiceFields(inv) {
  if (!inv) return null;
  const lines = inv.LineItems ?? [];
  return {
    invoiceId: inv.InvoiceID ?? null,
    invoiceNumber: inv.InvoiceNumber ?? null,
    reference: inv.Reference ?? null,
    contact: inv.Contact?.Name ?? null,
    contactId: inv.Contact?.ContactID ?? null,
    type: inv.Type ?? null,
    status: inv.Status ?? null,
    date: normDate(inv.Date ?? inv.DateString),
    dueDate: normDate(inv.DueDate ?? inv.DueDateString),
    subTotal: inv.SubTotal != null ? Number(inv.SubTotal) : null,
    totalTax: inv.TotalTax != null ? Number(inv.TotalTax) : null,
    total: inv.Total != null ? Number(inv.Total) : null,
    amountDue: inv.AmountDue != null ? Number(inv.AmountDue) : null,
    lineItems: lines.map((l) => ({
      description: l.Description ?? null,
      quantity: l.Quantity != null ? Number(l.Quantity) : null,
      unitAmount: l.UnitAmount != null ? Number(l.UnitAmount) : null,
      accountCode: l.AccountCode ?? null,
      taxType: l.TaxType ?? null,
      lineAmount: l.LineAmount != null ? Number(l.LineAmount) : null,
    })),
  };
}

async function readInvoiceById(invoiceId) {
  const rb = await execRead("xero_get_invoice", { invoiceId });
  const inv = rb.body?.result?.invoice;
  return { ok: rb.status === 200 && Boolean(inv), fields: readInvoiceFields(inv), raw: inv };
}

async function planDraft(args, idempotencyKey) {
  const call = await mcpCall("tools/call", {
    name: "plan_xero_draft_invoice",
    arguments: { ...args, ...(idempotencyKey ? { idempotencyKey } : {}) },
  });
  const plan = toolPayload(call.body);
  return { call, plan, confirmationToken: plan?.confirmationToken ?? null };
}

async function confirmPlan(planId, confirmationToken) {
  const call = await mcpCall("tools/call", {
    name: "confirm_action_plan",
    arguments: { planId, confirmationToken },
  });
  return { call, payload: toolPayload(call.body) };
}

async function executePlan(planId) {
  const call = await mcpCall("tools/call", {
    name: "execute_action_plan",
    arguments: { planId },
  });
  return { call, payload: toolPayload(call.body) };
}

async function dryRun(planId) {
  const call = await mcpCall("tools/call", {
    name: "dry_run_action_plan",
    arguments: { planId },
  });
  return toolPayload(call.body);
}

async function fullDraftFlow(args, { idempotencyKey, expectExecute = true, pauseAfter = true } = {}) {
  const { plan, confirmationToken } = await planDraft(args, idempotencyKey);
  const targetValid = plan?.targets?.[0]?.validation === "valid";
  if (!plan?.planId) {
    return { ok: false, stage: "plan", plan, executed: false };
  }
  if (!targetValid && expectExecute) {
    return { ok: false, stage: "plan_validation", plan, executed: false };
  }
  if (!expectExecute) {
    return { ok: !targetValid || plan?.targets?.[0]?.validation !== "valid", stage: "plan_only", plan };
  }
  const dry = await dryRun(plan.planId);
  const confirmed = await confirmPlan(plan.planId, confirmationToken);
  if (confirmed.payload?.confirmationStatus !== "confirmed") {
    return { ok: false, stage: "confirm", plan, confirmed: confirmed.payload, executed: false };
  }
  const executed = await executePlan(plan.planId);
  const execResult = executed.payload?.executionResult;
  const invoiceId = execResult?.xeroResourceId ?? execResult?.results?.invoiceId ?? execResult?.results?.xeroInvoiceId ?? null;
  const readback = invoiceId ? await readInvoiceById(invoiceId) : { ok: false, fields: null };
  if (pauseAfter && expectExecute) await sleep(WRITE_DELAY_MS);
  return {
    ok: execResult?.ok === true && readback.ok,
    stage: "executed",
    plan,
    dry,
    confirmed: confirmed.payload,
    executed: executed.payload,
    invoiceId,
    invoiceNumber: execResult?.humanReference ?? readback.fields?.invoiceNumber,
    readback,
  };
}

const discovery = {};
const results = [];
const created = [];

function ref(n) {
  return `INFRA-ALPHA-WRITE-${String(n).padStart(2, "0")}-${DATE_STAMP}`;
}

function shouldRun(testNum) {
  return FROM_TEST <= testNum;
}

function record(testNum, name, pass, detail) {
  results.push({ test: testNum, name, pass, ...detail });
}

async function verifyPriorInvoice(testNum, invoiceId, checks = {}) {
  const rb = await readInvoiceById(invoiceId);
  const f = rb.fields;
  const pass =
    rb.ok &&
    f?.status === "DRAFT" &&
    String(f?.reference ?? "").startsWith(`INFRA-ALPHA-WRITE-${String(testNum).padStart(2, "0")}`) &&
    (checks.total == null || approxEqual(f?.total, checks.total));
  if (pass && f) created.push({ test: testNum, ...f });
  record(testNum, checks.name ?? `Prior test ${testNum} readback`, pass, {
    invoiceId,
    invoiceNumber: f?.invoiceNumber,
    reference: f?.reference,
    total: f?.total,
    prior: true,
  });
  return pass;
}

setupIdentity();
await mcpCall("initialize", { protocolVersion: "2025-03-26" });

try {
  const org = await execRead("xero_get_organisation");
  discovery.organisation = org.body?.result?.organisationName ?? org.body?.result?.organisation?.Name;

  const contacts = await execRead("xero_list_contacts", { query: "Elvex", contactType: "customer", limit: 10 });
  const elvex = (contacts.body?.result?.contacts ?? []).find((c) =>
    String(c.Name ?? "").toUpperCase().includes("ELVEX"),
  );
  discovery.elvexContactId = elvex?.ContactID ?? null;
  discovery.elvexContactName = elvex?.Name ?? null;

  const accounts = await execRead("xero_list_accounts");
  const sales = (accounts.body?.result?.accounts ?? []).find(
    (a) => String(a.Code) === "200" || String(a.Name ?? "").toLowerCase().includes("sales"),
  );
  discovery.salesAccountCode = sales?.Code ?? "200";
  discovery.salesAccountName = sales?.Name ?? "Sales";

  const tax = await execRead("xero_vat_capability");
  discovery.taxRates = tax.body?.result?.taxRates?.slice(0, 5) ?? [];
  discovery.noVatTaxType = "NONE";

  console.error("DISCOVERY:", JSON.stringify(discovery, null, 2));

  const base = {
    contactName: discovery.elvexContactName ?? "ELVEX PROPERTY SERVICES LTD",
    accountCode: discovery.salesAccountCode,
    taxTreatment: "No VAT",
    invoiceDate: TODAY,
    dueDate: TOMORROW,
  };

  const priorInvoices = {
    1: { id: "c3bf4cf7-519a-42c5-afae-657e6893a272", total: 0.01, name: "Basic 1p draft invoice" },
    2: { id: "be18e561-b4c7-4547-bc2c-77a8d1388152", total: 1, name: "£1 draft invoice" },
    3: { id: "b89cc080-cd6b-4e27-af9c-1557bb5f350b", total: 12.34, name: "Decimal amount £12.34" },
    4: { id: "fa2fc846-2c0f-42e4-8d50-598dcc4ae7b3", total: 0.06, name: "Multiple line items £0.06" },
    5: { id: "4cf07fad-8d42-4813-ad5e-b6683c3856fa", total: 0.3, name: "Quantity calculation 3×£0.10" },
    6: { id: "d57660e9-0d0e-4e26-a858-6f84a6deaf6d", total: 0.01, name: "Description handling" },
    7: { id: "ae209079-dde4-416c-902e-a7157ff956f5", total: 0.01, name: "Reference handling" },
    8: { id: "70699a6c-7da6-4833-a344-c12f6cc47afc", total: 0.01, name: "Invoice date today" },
  };

  for (const [num, meta] of Object.entries(priorInvoices)) {
    const testNum = Number(num);
    if (FROM_TEST > testNum) {
      await verifyPriorInvoice(testNum, meta.id, { total: meta.total, name: meta.name });
    }
  }

  // TEST 01 — 1p draft
  if (shouldRun(1)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(1),
      lineItems: [{ description: "INFRA Alpha Test 01", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass =
      r.ok &&
      f?.status === "DRAFT" &&
      f?.reference === ref(1) &&
      Math.abs((f?.total ?? 0) - 0.01) < 0.001;
    if (pass) created.push({ test: 1, ...f });
    record(1, "Basic 1p draft invoice", pass, { invoiceId: f?.invoiceId, invoiceNumber: f?.invoiceNumber, total: f?.total });
  }

  // TEST 02 — £1
  if (shouldRun(2)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(2),
      lineItems: [{ description: "INFRA Alpha Test 02", quantity: 1, unitAmount: 1, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass = r.ok && f?.status === "DRAFT" && Math.abs((f?.total ?? 0) - 1) < 0.001;
    if (pass) created.push({ test: 2, ...f });
    record(2, "£1 draft invoice", pass, { total: f?.total });
  }

  // TEST 03 — Decimal £12.34
  if (shouldRun(3)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(3),
      lineItems: [{ description: "INFRA Alpha Test 03", quantity: 1, unitAmount: 12.34, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass = r.ok && Math.abs((f?.total ?? 0) - 12.34) < 0.001;
    if (pass) created.push({ test: 3, ...f });
    record(3, "Decimal amount £12.34", pass, { total: f?.total });
  }

  // TEST 04 — Multiple lines £0.06
  if (shouldRun(4)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(4),
      lineItems: [
        { description: "INFRA Alpha Test 04 line 1", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode },
        { description: "INFRA Alpha Test 04 line 2", quantity: 1, unitAmount: 0.02, accountCode: base.accountCode },
        { description: "INFRA Alpha Test 04 line 3", quantity: 1, unitAmount: 0.03, accountCode: base.accountCode },
      ],
    });
    const f = r.readback?.fields;
    const pass = r.ok && Math.abs((f?.total ?? 0) - 0.06) < 0.001 && (f?.lineItems?.length ?? 0) === 3;
    if (pass) created.push({ test: 4, ...f });
    record(4, "Multiple line items £0.06", pass, { total: f?.total, lineCount: f?.lineItems?.length });
  }

  // TEST 05 — Quantity 3 × £0.10 = £0.30
  if (shouldRun(5)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(5),
      lineItems: [{ description: "INFRA Alpha Test 05", quantity: 3, unitAmount: 0.1, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass = r.ok && Math.abs((f?.total ?? 0) - 0.3) < 0.001;
    if (pass) created.push({ test: 5, ...f });
    record(5, "Quantity calculation 3×£0.10", pass, { total: f?.total });
  }

  // TEST 06 — Long description
  if (shouldRun(6)) {
    const desc =
      "INFRA Alpha Test 06 — Professional services consultation for quarterly review and compliance documentation support";
    const r = await fullDraftFlow({
      ...base,
      reference: ref(6),
      lineItems: [{ description: desc, quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass = r.ok && f?.lineItems?.[0]?.description === desc;
    if (pass) created.push({ test: 6, ...f });
    record(6, "Description handling", pass, { description: f?.lineItems?.[0]?.description?.slice(0, 60) });
  }

  // TEST 07 — Reference exact match
  if (shouldRun(7)) {
    const reference = ref(7);
    const r = await fullDraftFlow({
      ...base,
      reference,
      lineItems: [{ description: "INFRA Alpha Test 07", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass = r.ok && f?.reference === reference;
    if (pass) created.push({ test: 7, ...f });
    record(7, "Reference handling", pass, { reference: f?.reference });
  }

  // TEST 08 — Invoice date today
  if (shouldRun(8)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(8),
      invoiceDate: TODAY,
      lineItems: [{ description: "INFRA Alpha Test 08", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass = r.ok && f?.date === TODAY;
    if (pass) created.push({ test: 8, ...f });
    record(8, "Invoice date today", pass, { date: f?.date });
  }

  // TEST 09 — Due date tomorrow
  if (shouldRun(9)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(9),
      dueDate: TOMORROW,
      lineItems: [{ description: "INFRA Alpha Test 09", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass = r.ok && f?.dueDate === TOMORROW;
    if (pass) created.push({ test: 9, ...f });
    record(9, "Due date tomorrow", pass, { dueDate: f?.dueDate });
  }

  // TEST 10 — Explicit sales account
  if (shouldRun(10)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(10),
      lineItems: [
        {
          description: "INFRA Alpha Test 10",
          quantity: 1,
          unitAmount: 0.01,
          accountCode: discovery.salesAccountCode,
        },
      ],
    });
    const f = r.readback?.fields;
    const pass = r.ok && f?.lineItems?.[0]?.accountCode === String(discovery.salesAccountCode);
    if (pass) created.push({ test: 10, ...f });
    record(10, "Sales account explicit", pass, { accountCode: f?.lineItems?.[0]?.accountCode });
  }

  // TEST 11 — No VAT, tax = 0
  if (shouldRun(11)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(11),
      taxTreatment: "No VAT",
      lineItems: [{ description: "INFRA Alpha Test 11", quantity: 1, unitAmount: 1, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass =
      r.ok &&
      (f?.totalTax === 0 || f?.totalTax === null) &&
      (f?.lineItems?.[0]?.taxType === "NONE" || f?.lineItems?.[0]?.taxType === "ZERORATEDOUTPUT");
    if (pass) created.push({ test: 11, ...f });
    record(11, "No VAT", pass, { totalTax: f?.totalTax, taxType: f?.lineItems?.[0]?.taxType });
  }

  // TEST 12 — Multiple lines with quantities
  if (shouldRun(12)) {
    const r = await fullDraftFlow({
      ...base,
      reference: ref(12),
      lineItems: [
        { description: "INFRA Alpha Test 12a", quantity: 2, unitAmount: 0.05, accountCode: base.accountCode },
        { description: "INFRA Alpha Test 12b", quantity: 3, unitAmount: 0.04, accountCode: base.accountCode },
        { description: "INFRA Alpha Test 12c", quantity: 1, unitAmount: 0.07, accountCode: base.accountCode },
      ],
    });
    const f = r.readback?.fields;
    const expected = 2 * 0.05 + 3 * 0.04 + 1 * 0.07;
    const pass = r.ok && approxEqual(f?.total, expected);
    if (pass) created.push({ test: 12, ...f });
    record(12, "Multiple lines with quantities", pass, { total: f?.total, expected });
  }

  // TEST 13 — Contact by exact name (no ID)
  if (shouldRun(13)) {
    const r = await fullDraftFlow({
      contactName: discovery.elvexContactName,
      reference: ref(13),
      invoiceDate: TODAY,
      dueDate: TOMORROW,
      taxTreatment: "No VAT",
      lineItems: [{ description: "INFRA Alpha Test 13", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
    });
    const f = r.readback?.fields;
    const pass =
      r.ok &&
      f?.contactId === discovery.elvexContactId &&
      String(f?.contact ?? "").toUpperCase().includes("ELVEX");
    if (pass) created.push({ test: 13, ...f });
    record(13, "Contact resolution by name", pass, { contact: f?.contact, contactId: f?.contactId });
  }

  // TEST 14 — Contact typo safety (must NOT create invoice)
  if (shouldRun(14)) {
    const { plan } = await planDraft({
      contactName: "Elvex Property Servces Ltd",
      reference: ref(14),
      lineItems: [{ description: "INFRA Alpha Test 14", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
      taxTreatment: "No VAT",
    });
    const validation = plan?.targets?.[0]?.validation;
    const pass = validation !== "valid";
    record(14, "Contact typo safety", pass, { validation, detail: plan?.targets?.[0]?.validationDetail });
  }

  // TEST 15 — Missing required field (empty line items)
  if (shouldRun(15)) {
    const { plan } = await planDraft({
      contactName: discovery.elvexContactName,
      reference: ref(15),
      lineItems: [],
      taxTreatment: "No VAT",
    });
    const total = plan?.financialImpact?.totalAmount ?? plan?.review?.total ?? 0;
    const validation = plan?.targets?.[0]?.validation;
    const pass = validation !== "valid" || total <= 0;
    record(15, "Missing required field", pass, { validation, total, summary: plan?.summary });
  }

  // TEST 16 — Invalid account code (reject at plan or execute; no invoice)
  if (shouldRun(16)) {
    const r = await fullDraftFlow(
      {
        contactName: discovery.elvexContactName,
        reference: ref(16),
        taxTreatment: "No VAT",
        lineItems: [{ description: "INFRA Alpha Test 16", quantity: 1, unitAmount: 0.01, accountCode: "99999" }],
      },
      { expectExecute: true },
    );
    const validation = r.plan?.targets?.[0]?.validation;
    const pass =
      !r.ok &&
      (r.stage === "plan_validation" || r.stage === "executed") &&
      validation !== "valid";
    record(16, "Invalid account code", pass, {
      stage: r.stage,
      validation,
      error: r.executed?.executionResult?.error ?? r.plan?.targets?.[0]?.validationDetail ?? r.plan?.summary,
    });
  }

  // TEST 17 — Invalid tax type
  if (shouldRun(17)) {
    const r = await fullDraftFlow(
      {
        contactName: discovery.elvexContactName,
        reference: ref(17),
        taxType: "INVALID_TAX_XYZ",
        lineItems: [{ description: "INFRA Alpha Test 17", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
      },
      { expectExecute: true },
    );
    const pass = !r.ok;
    record(17, "Invalid tax type", pass, { stage: r.stage, validation: r.plan?.targets?.[0]?.validation });
  }

  // TEST 18 — Idempotency (same idempotency key → one plan, one invoice)
  if (shouldRun(18)) {
    const idem = `alpha-write-18-${DATE_STAMP}-${randomBytes(4).toString("hex")}`;
    const args = {
      contactName: discovery.elvexContactName,
      reference: ref(18),
      taxTreatment: "No VAT",
      lineItems: [{ description: "INFRA Alpha Test 18", quantity: 1, unitAmount: 0.01, accountCode: base.accountCode }],
    };
    const first = await fullDraftFlow({ ...args, idempotencyKey: idem });
    const plan2 = await planDraft({ ...args, idempotencyKey: idem });
    const samePlan = plan2.plan?.planId === first.plan?.planId;
    const pass = first.ok && samePlan;
    if (first.ok && first.readback?.fields) created.push({ test: 18, ...first.readback.fields });
    record(18, "Duplicate/idempotency", pass, {
      planId1: first.plan?.planId,
      planId2: plan2.plan?.planId,
      samePlan,
    });
  }

  // TEST 19 — Direct-write bypass
  if (shouldRun(19)) {
    const bypass = await execGatewayWrite("xero_create_draft_invoice", {
      contactId: discovery.elvexContactId,
      lineItems: [{ description: "BYPASS", quantity: 1, unitAmount: 0.01 }],
      reference: ref(19),
    });
    const pass = bypassBlocked(bypass.body, bypass.status);
    record(19, "Direct-write bypass blocked", pass, {
      status: bypass.status,
      code: bypass.body?.code,
      error: bypass.body?.error,
    });
  }

  // TEST 20 — Realistic multi-line draft
  if (shouldRun(20)) {
    const r = await fullDraftFlow({
      contactName: discovery.elvexContactName,
      reference: ref(20),
      invoiceDate: TODAY,
      dueDate: TOMORROW,
      taxTreatment: "No VAT",
      lineItems: [
        { description: "Site survey and assessment", quantity: 1, unitAmount: 0.5, accountCode: base.accountCode },
        { description: "Compliance documentation review", quantity: 2, unitAmount: 0.15, accountCode: base.accountCode },
        { description: "Administrative processing fee", quantity: 1, unitAmount: 0.05, accountCode: base.accountCode },
      ],
    });
    const f = r.readback?.fields;
    const expected = 0.5 + 2 * 0.15 + 0.05;
    const pass =
      r.ok &&
      f?.status === "DRAFT" &&
      f?.type === "ACCREC" &&
      Math.abs((f?.total ?? 0) - expected) < 0.001 &&
      (f?.lineItems?.length ?? 0) === 3;
    if (pass) created.push({ test: 20, ...f });
    record(20, "Complete realistic invoice", pass, {
      invoiceNumber: f?.invoiceNumber,
      total: f?.total,
      status: f?.status,
      lineCount: f?.lineItems?.length,
    });
  }

  // Inventory: read back every created invoice and filter INFRA-ALPHA-WRITE references
  const inventoryVerified = [];
  for (const row of created) {
    if (!row.invoiceId) continue;
    const rb = await readInvoiceById(row.invoiceId);
    if (rb.fields?.reference?.startsWith("INFRA-ALPHA-WRITE-")) {
      inventoryVerified.push(rb.fields);
    }
  }

  const report = {
    fromTest: FROM_TEST,
    discovery,
    results,
    createdManifest: created.map((c) => ({
      test: c.test,
      invoiceNumber: c.invoiceNumber,
      invoiceId: c.invoiceId,
      reference: c.reference,
      customer: c.contact,
      amount: c.total,
      status: c.status,
    })),
    inventoryCount: inventoryVerified.length,
    inventoryReferences: inventoryVerified.map((i) => i.reference),
    passCount: results.filter((r) => r.pass).length,
    failCount: results.filter((r) => !r.pass).length,
    totalTests: results.length,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.failCount > 0 ? 1 : 0);
} finally {
  cleanupIdentity();
}
