#!/usr/bin/env node
/** Read-only: fetch Xero tax rates and account 200 for Caddington. */
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
const scopes = JSON.stringify(["xero.accounts.read", "xero.organisation.read"]);
const sqlFile = join(apiDir, ".tmp-tax-probe.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP tax probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function execTool(toolName, args = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: "co_caddington", toolName, arguments: args, sourceClient: "tax-probe" }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const accounts = await execTool("xero_list_accounts");
const org = await execTool("xero_get_organisation");
const sales200 = accounts.body?.result?.accounts?.filter((a) => String(a.Code) === "200") ?? [];

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id='${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      organisation: org.body?.result?.organisationName,
      account200: sales200.map((a) => ({
        Code: a.Code,
        Name: a.Name,
        Type: a.Type,
        TaxType: a.TaxType,
        Class: a.Class,
      })),
      allAccountsSample: (accounts.body?.result?.accounts ?? []).slice(0, 5).map((a) => ({
        Code: a.Code,
        Name: a.Name,
        TaxType: a.TaxType,
      })),
    },
    null,
    2,
  ),
);
