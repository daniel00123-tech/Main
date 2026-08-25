#!/usr/bin/env node
/**
 * Xero first-write readiness probe — dry run only, no mutations.
 * Never prints tokens or secrets.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const scopes = JSON.stringify([
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.cancel",
  "xero.action.list",
  "xero.organisation.read",
  "xero.invoices.read",
]);

const sqlFile = join(apiDir, ".tmp-xero-write-probe.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP xero write probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
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

const xeroInstance = d1Query(
  "SELECT id, auth_status, capabilities_enabled_json, display_account_name FROM connector_instances WHERE company_id = 'co_caddington' AND auth_status = 'connected' AND capabilities_enabled_json LIKE '%accounting.invoices%'",
)[0];

const grantedScopes = xeroInstance?.capabilities_enabled_json
  ? JSON.parse(String(xeroInstance.capabilities_enabled_json))
  : [];

await mcp("initialize", { protocolVersion: "2025-03-26" }, 1);

const directWrite = await mcp(
  "tools/call",
  {
    name: "xero_create_draft_invoice",
    arguments: {
      contactId: "00000000-0000-0000-0000-000000000001",
      lineItems: [{ description: "test", quantity: 1, unitAmount: 1 }],
    },
  },
  2,
);

const list = await mcp("tools/list", {}, 3);
const toolNames = (list.body?.result?.tools ?? []).map((t) => t.name);

// Plan without contactId to verify requirement; dry-run only if plan succeeds
const planAttempt = await mcp(
  "tools/call",
  {
    name: "plan_xero_draft_invoice",
    arguments: {
      lineItems: [
        {
          description: "INFRA Xero Write Acceptance Test",
          quantity: 1,
          unitAmount: 1.0,
        },
      ],
      reference: "INFRA-ACCEPTANCE-TEST",
    },
  },
  4,
);

let dryRun = null;
const planBody = planAttempt.body?.result?.content?.[0]?.text;
let parsedPlan = null;
if (planBody) {
  try {
    parsedPlan = JSON.parse(planBody);
  } catch {
    parsedPlan = { raw: planBody.slice(0, 300) };
  }
}
if (parsedPlan?.planId) {
  dryRun = await mcp(
    "tools/call",
    { name: "dry_run_action_plan", arguments: { planId: parsedPlan.planId } },
    5,
  );
}

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

function parseToolResult(body) {
  const text = body?.result?.content?.[0]?.text;
  if (!text) return body?.error ?? body?.result ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

console.log(
  JSON.stringify(
    {
      productionOAuth: {
        instanceId: xeroInstance?.id ?? null,
        organisation: xeroInstance?.display_account_name ?? null,
        authStatus: xeroInstance?.auth_status ?? null,
        hasAccountingInvoices: grantedScopes.includes("accounting.invoices"),
        grantedScopes,
      },
      directWriteBypass: {
        status: directWrite.status,
        blocked:
          directWrite.body?.error?.code === "ACTION_ENGINE_REQUIRED" ||
          String(directWrite.body?.error?.message ?? "").includes("ACTION_ENGINE_REQUIRED") ||
          !toolNames.includes("xero_create_draft_invoice"),
        error: directWrite.body?.error ?? null,
        writeToolInCatalogue: toolNames.includes("xero_create_draft_invoice"),
      },
      actionEnginePlanning: {
        planStatus: planAttempt.status,
        planResult: parseToolResult(planAttempt.body),
        contactIdRequired:
          !parsedPlan?.planId &&
          (String(JSON.stringify(parseToolResult(planAttempt.body))).includes("contact") ||
            String(JSON.stringify(parseToolResult(planAttempt.body))).includes("Contact")),
      },
      dryRun: dryRun
        ? {
            status: dryRun.status,
            result: parseToolResult(dryRun.body),
          }
        : {
            skipped: true,
            reason: parsedPlan?.planId
              ? "unknown"
              : "plan_xero_draft_invoice did not return planId — ContactID likely required",
          },
      acceptanceParameters: {
        organisation: "Caddington Holdings Ltd",
        action: "Create DRAFT sales invoice (ACCREC)",
        amountGbp: 1.0,
        reference: "INFRA-ACCEPTANCE-TEST",
        description: "INFRA Xero Write Acceptance Test",
      },
    },
    null,
    2,
  ),
);
