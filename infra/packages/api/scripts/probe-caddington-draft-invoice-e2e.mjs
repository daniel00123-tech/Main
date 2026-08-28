#!/usr/bin/env node
/**
 * Production E2E acceptance for Caddington draft invoice workflow.
 * Creates a reversible £1 DRAFT invoice via Action Engine (plan → confirm → approve → execute).
 * Requires FINANCIAL_WRITES_ENABLED=true and live Xero OAuth for co_caddington.
 *
 * REQUIRES: ALLOW_XERO_PRODUCTION_WRITE=true or EXECUTE=true or --allow-production-write
 */
import { assertProductionWriteAllowed } from "./lib/xero-script-guard.mjs";
assertProductionWriteAllowed();

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const EXECUTE = process.env.EXECUTE === "true";
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
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const sqlFile = join(apiDir, ".tmp-e2e.sql");

function runSql(sql) {
  writeFileSync(sqlFile, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });
}

runSql(
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP e2e probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
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

async function execRead(toolName, args = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: "co_caddington", toolName, arguments: args, sourceClient: "e2e-probe" }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const report = { mode: EXECUTE ? "full_e2e" : "dry_run_only", steps: [] };

try {
  await mcpCall("initialize", { protocolVersion: "2025-03-26" }, 1);

  const accountsBefore = await execRead("xero_list_accounts");
  report.steps.push({
    step: "xero_list_accounts",
    ok: accountsBefore.status === 200 && (accountsBefore.body?.result?.accounts?.length ?? 0) > 0,
    account200: (accountsBefore.body?.result?.accounts ?? [])
      .filter((a) => String(a.Code) === "200")
      .map((a) => ({ Code: a.Code, Name: a.Name, TaxType: a.TaxType })),
  });

  const planCall = await mcpCall(
    "tools/call",
    {
      name: "plan_xero_draft_invoice",
      arguments: {
        contactName: "ELVEX PROPERTY SERVICES LTD",
        lineItems: [{ description: "E2E acceptance test", quantity: 1, unitAmount: 1, accountCode: "200" }],
        reference: `E2E-${Date.now()}`,
        invoiceDate: "2026-08-25",
        dueDate: "2026-08-26",
        taxTreatment: "No VAT",
      },
    },
    2,
  );
  const plan = toolPayload(planCall.body);
  const confirmationToken = plan?.confirmationToken ?? null;
  report.steps.push({
    step: "plan_xero_draft_invoice",
    ok: Boolean(plan?.planId),
    planId: plan?.planId ?? null,
    status: plan?.status ?? null,
    review: plan?.review ?? null,
    permission: plan?.permission ?? null,
  });

  if (!plan?.planId) throw new Error("Plan creation failed");

  const dryRun = toolPayload((await mcpCall("tools/call", { name: "dry_run_action_plan", arguments: { planId: plan.planId } }, 3)).body);
  report.steps.push({
    step: "dry_run_action_plan",
    ok: dryRun?.dueDate === "2026-08-26" && dryRun?.taxType === "NONE" && dryRun?.type === "ACCREC",
    dueDate: dryRun?.dueDate ?? null,
    taxType: dryRun?.taxType ?? null,
    type: dryRun?.type ?? null,
    readyToExecute: dryRun?.readyToExecute ?? null,
    headline: dryRun?.headline ?? null,
  });

  if (!EXECUTE) {
    report.summary = "Dry-run complete. Set EXECUTE=true to confirm, approve, and create DRAFT invoice.";
  } else {
    const confirm = toolPayload(
      (
        await mcpCall(
          "tools/call",
          {
            name: "confirm_action_plan",
            arguments: { planId: plan.planId, confirmationToken },
          },
          4,
        )
      ).body,
    );
    report.steps.push({
      step: "confirm_action_plan",
      ok: confirm?.confirmationStatus === "confirmed",
      status: confirm?.status ?? null,
      message: confirm?.message ?? null,
    });

    if (confirm?.confirmationStatus !== "confirmed") {
      throw new Error(`Confirm failed: ${confirm?.message ?? confirm?.error ?? "unknown"}`);
    }

    if (confirm?.status !== "approved") {
      throw new Error(`Expected approved after confirm without portal step, got ${confirm?.status ?? "unknown"}`);
    }

    const execute = toolPayload(
      (await mcpCall("tools/call", { name: "execute_action_plan", arguments: { planId: plan.planId } }, 5)).body,
    );
    report.steps.push({
      step: "execute_action_plan",
      ok: execute?.executionResult?.ok === true,
      execution: execute?.executionResult ?? null,
      invoiceId: execute?.executionResult?.xeroResourceId ?? null,
      invoiceNumber: execute?.executionResult?.humanReference ?? null,
    });

    const invoiceId = execute?.executionResult?.xeroResourceId;
    if (invoiceId) {
      const readBackCall = await mcpCall(
        "tools/call",
        { name: "xero_get_invoice", arguments: { invoiceId } },
        6,
      );
      const readPayload = toolPayload(readBackCall.body);
      const invoice = readPayload?.invoice;
      report.steps.push({
        step: "xero_get_invoice_readback",
        ok: Boolean(invoice?.Status === "DRAFT" && invoice?.InvoiceNumber),
        status: invoice?.Status ?? null,
        invoiceNumber: invoice?.InvoiceNumber ?? null,
        total: invoice?.Total ?? null,
        dueDate: invoice?.DueDateString?.slice(0, 10) ?? null,
        taxType: invoice?.LineItems?.[0]?.TaxType ?? null,
        error: readBackCall.body?.error?.message ?? readPayload?.error ?? null,
      });
    }

    report.summary = report.steps.every((s) => s.ok !== false) ? "E2E acceptance passed" : "E2E acceptance had failures";
  }
} finally {
  runSql(`DELETE FROM service_identities WHERE id='${id}';`);
  if (sqlFile) try { unlinkSync(sqlFile); } catch { /* ignore */ }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.steps.some((s) => s.ok === false) ? 1 : 0);
