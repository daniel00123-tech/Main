#!/usr/bin/env node
/**
 * Minimal read-only Xero acceptance for production reconciliation.
 * Creates temporary service identity, runs 3 read tools, deletes identity.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const COMPANY_ID = "co_caddington";
const MCP_ID = "mcp_caddington_primary";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function hashServiceToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const prefix = token.slice(0, 12);
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const now = new Date().toISOString();
const scopes = JSON.stringify([
  "xero.organisation.read",
  "xero.reports.pnl.read",
  "xero.invoices.read",
  "xero.sales.summary",
]);

const sqlFile = join(apiDir, ".tmp-xero-acceptance.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', '${COMPANY_ID}', 'TEMP reconciliation probe', 'auto cleanup', 'active', NULL, 'chatgpt', '${hashServiceToken(token)}', '${prefix}', NULL, 0, '${scopes.replace(/'/g, "''")}', '${MCP_ID}', '${now}', '${now}');`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "inherit",
});
unlinkSync(sqlFile);

async function execute(toolName, arguments_ = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      companyId: COMPANY_ID,
      toolName,
      arguments: arguments_,
      sourceClient: "reconciliation-probe",
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const org = await execute("xero_get_organisation");
const sales = await execute("xero_sales_summary", {
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
});
const pnl = await execute("xero_profit_and_loss", {
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
});

writeFileSync(
  join(apiDir, ".tmp-xero-acceptance-cleanup.sql"),
  `DELETE FROM service_identities WHERE id = '${id}';`,
);
execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", join(apiDir, ".tmp-xero-acceptance-cleanup.sql")],
  { cwd: apiDir, stdio: "inherit" },
);
unlinkSync(join(apiDir, ".tmp-xero-acceptance-cleanup.sql"));

function summarise(label, r) {
  const ok = r.status === 200;
  const result = r.body?.result ?? r.body?.data?.result ?? null;
  return {
    tool: label,
    httpStatus: r.status,
    ok,
    organisationName: result?.organisationName ?? result?.organisation?.Name ?? null,
    error: r.body?.error ?? null,
    hasData: Boolean(result && Object.keys(result).length > 0),
  };
}

console.log(
  JSON.stringify(
    {
      acceptance: [
        summarise("xero_get_organisation", org),
        summarise("xero_sales_summary", sales),
        summarise("xero_profit_and_loss", pnl),
      ],
    },
    null,
    2,
  ),
);
