#!/usr/bin/env node
/** tools/list using live production infra_1HS3Nn scopes from D1. */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const scopesRaw = execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "infra-control-plane",
    "--remote",
    "--command",
    "SELECT scopes_json FROM service_identities WHERE token_prefix='infra_1HS3Nn' AND status='active' LIMIT 1;",
    "--json",
  ],
  { cwd: apiDir, encoding: "utf8" },
);
const scopes = JSON.parse(JSON.parse(scopesRaw)[0].results[0].scopes_json);

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const sqlFile = join(apiDir, ".tmp-live-scopes.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP live scopes probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${JSON.stringify(scopes).replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

const res = await fetch(MCP, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
const body = await res.json();
const names = body?.result?.tools?.map((t) => t.name) ?? [];

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id='${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      productionIdentityPrefix: "infra_1HS3Nn",
      scopeCount: scopes.length,
      actionScopes: scopes.filter((s) => s.startsWith("xero.action.")),
      toolCount: names.length,
      actionTools: names.filter((n) => n.includes("action") || n.startsWith("plan_xero")),
      hasExecuteActionPlan: names.includes("execute_action_plan"),
      hasPlanXeroDraftInvoice: names.includes("plan_xero_draft_invoice"),
      hasDirectWrite: names.includes("xero_create_draft_invoice"),
    },
    null,
    2,
  ),
);
