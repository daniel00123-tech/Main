#!/usr/bin/env node
/**
 * Production ChatGPT-equivalent acceptance: plan → confirm → execute (no portal/SQL approval).
 * Creates one £1 DRAFT sales invoice for Elvex Property Services Ltd in Caddington Xero.
 *
 * Set EXECUTE=true to perform the live write (default: dry-run only).
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const EXECUTE = process.env.EXECUTE === "true";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const today = new Date();
const invoiceDate = today.toISOString().slice(0, 10);
const dueTomorrow = new Date(today);
dueTomorrow.setUTCDate(dueTomorrow.getUTCDate() + 1);
const dueDate = dueTomorrow.toISOString().slice(0, 10);

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
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const sqlFile = join(apiDir, ".tmp-chatgpt-acceptance.sql");

function runSql(sql) {
  writeFileSync(sqlFile, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });
}

runSql(
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP chatgpt acceptance', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);

async function mcpCall(method, params, rpcId) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
}

function toolPayload(body) {
  const text = body?.result?.content?.find((p) => p.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

const report = {
  mode: EXECUTE ? "full_chatgpt_acceptance" : "dry_run_only",
  acceptanceScenario: {
    customer: "Elvex Property Services Ltd",
    amountGbp: 1,
    description: "test",
    reference: "123",
    salesAccount: "Sales (auto-resolve)",
    taxTreatment: "No VAT",
    invoiceDate,
    dueDate,
    status: "DRAFT",
  },
  steps: [],
};

try {
  await mcpCall("initialize", { protocolVersion: "2025-03-26" }, 1);

  const planCall = await mcpCall(
    "tools/call",
    {
      name: "plan_xero_draft_invoice",
      arguments: {
        contactName: "Elvex Property Services Ltd",
        lineItems: [{ description: "test", quantity: 1, unitAmount: 1, accountName: "Sales" }],
        reference: "123",
        invoiceDate,
        dueDate,
        taxTreatment: "No VAT",
      },
    },
    2,
  );
  const plan = toolPayload(planCall.body);
  report.steps.push({
    step: "plan_xero_draft_invoice",
    ok: Boolean(plan?.planId),
    planId: plan?.planId ?? null,
    status: plan?.status ?? null,
    permission: plan?.permission ?? null,
    review: plan?.review ?? null,
  });

  if (!plan?.planId) throw new Error("Plan creation failed");

  const dryRun = toolPayload((await mcpCall("tools/call", { name: "dry_run_action_plan", arguments: { planId: plan.planId } }, 3)).body);
  report.steps.push({
    step: "dry_run_action_plan",
    ok:
      dryRun?.dueDate === dueDate &&
      dryRun?.taxType === "NONE" &&
      dryRun?.type === "ACCREC" &&
      dryRun?.reference === "123" &&
      dryRun?.description === "test",
    readyToExecute: dryRun?.readyToExecute ?? null,
    headline: dryRun?.headline ?? null,
    approval: dryRun?.approval ?? null,
    accountCode: dryRun?.accountCode ?? null,
  });

  if (!EXECUTE) {
    report.summary = "Dry-run complete. Set EXECUTE=true for live ChatGPT-equivalent write.";
  } else {
    const confirm = toolPayload(
      (
        await mcpCall(
          "tools/call",
          { name: "confirm_action_plan", arguments: { planId: plan.planId, confirmationToken: plan.confirmationToken } },
          4,
        )
      ).body,
    );
    report.steps.push({
      step: "confirm_action_plan",
      ok: confirm?.confirmationStatus === "confirmed" && ["approved", "completed"].includes(String(confirm?.status)),
      status: confirm?.status ?? null,
      approvalStatus: confirm?.approvalStatus ?? null,
      message: confirm?.message ?? null,
      autoExecuted: Boolean(confirm?.executionResult),
    });

    if (!["approved", "completed"].includes(String(confirm?.status ?? ""))) {
      throw new Error(`Expected approved/completed after confirm, got ${confirm?.status ?? "unknown"}`);
    }

    let execution = confirm?.executionResult ?? null;
    if (!execution?.ok) {
      const executePayload = toolPayload(
        (await mcpCall("tools/call", { name: "execute_action_plan", arguments: { planId: plan.planId } }, 5)).body,
      );
      execution = executePayload?.executionResult ?? null;
      if (!execution?.ok && executePayload?.status === "completed") {
        const evidence = toolPayload(
          (await mcpCall("tools/call", { name: "get_action_plan", arguments: { planId: plan.planId } }, 51)).body,
        );
        execution = evidence?.execution ?? execution;
      }
    }

    report.steps.push({
      step: "execute_action_plan",
      ok: execution?.ok === true,
      execution,
      invoiceId: execution?.xeroResourceId ?? null,
      invoiceNumber: execution?.humanReference ?? null,
    });

    const invoiceId = execution?.xeroResourceId;
    if (invoiceId) {
      const readBack = toolPayload(
        (await mcpCall("tools/call", { name: "xero_get_invoice", arguments: { invoiceId } }, 6)).body,
      );
      const invoice = readBack?.invoice;
      report.steps.push({
        step: "xero_get_invoice_readback",
        ok: Boolean(
          invoice?.Status === "DRAFT" &&
            invoice?.InvoiceNumber &&
            Number(invoice?.Total) === 1 &&
            invoice?.Reference === "123" &&
            invoice?.LineItems?.[0]?.Description === "test",
        ),
        status: invoice?.Status ?? null,
        invoiceNumber: invoice?.InvoiceNumber ?? null,
        reference: invoice?.Reference ?? null,
        total: invoice?.Total ?? null,
        dueDate: invoice?.DueDateString?.slice(0, 10) ?? null,
        taxType: invoice?.LineItems?.[0]?.TaxType ?? null,
        lineDescription: invoice?.LineItems?.[0]?.Description ?? null,
      });
    }

    report.summary = report.steps.every((s) => s.ok !== false) ? "ChatGPT acceptance passed" : "Acceptance had failures";
    report.invoiceNumber = report.steps.find((s) => s.step === "execute_action_plan")?.invoiceNumber ?? null;
  }
} finally {
  runSql(`DELETE FROM service_identities WHERE id='${id}';`);
  try {
    unlinkSync(sqlFile);
  } catch {
    /* ignore */
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.steps.some((s) => s.ok === false) ? 1 : 0);
