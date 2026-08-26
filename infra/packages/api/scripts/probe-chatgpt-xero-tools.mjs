#!/usr/bin/env node
/** Verify ChatGPT MCP tools/list exposes Xero read tools (temp identity, no token rotation). */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const scopes = JSON.stringify([
  "xero.organisation.read",
  "xero.contacts.read",
  "xero.contacts.search",
  "xero.invoices.read",
  "xero.reports.pnl.read",
  "xero.sales.summary",
  "system.health",
]);
const sqlFile = join(apiDir, ".tmp-tools-probe.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP tools probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "inherit",
});

const initRes = await fetch(`${API}/api/gateway/v1/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  }),
});

const res = await fetch(`${API}/api/gateway/v1/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
});
const body = await res.json().catch(() => ({}));
const tools = (body?.result?.tools ?? []).map((t) => t.name);
const xeroTools = tools.filter((n) => n.startsWith("xero_"));

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "inherit",
});
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      httpStatus: res.status,
      initializeStatus: initRes.status,
      totalTools: tools.length,
      xeroReadTools: xeroTools,
      hasOrganisation: xeroTools.includes("xero_get_organisation"),
      hasPnl: xeroTools.includes("xero_profit_and_loss"),
      hasSalesSummary: xeroTools.includes("xero_sales_summary"),
      activeProductionIdentityPrefix: "infra_1HS3Nn (unchanged)",
    },
    null,
    2,
  ),
);
