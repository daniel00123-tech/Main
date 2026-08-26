#!/usr/bin/env node
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
  "xero.invoices.search",
  "xero.accounts.read",
  "xero.contacts.search",
  "xero.organisation.read",
]);
const sqlFile = join(apiDir, ".tmp-other-reads.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function execTool(tool, args = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      companyId: "co_caddington",
      toolName: tool,
      arguments: args,
      sourceClient: "probe",
    }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status,
    error: body.error ?? null,
    code: body.code ?? null,
    count:
      body.result?.contacts?.length ??
      body.result?.accounts?.length ??
      body.result?.invoices?.length ??
      null,
  };
}

const results = {
  org: await execTool("xero_get_organisation"),
  accounts: await execTool("xero_list_accounts"),
  invoices: await execTool("xero_search_invoices", {
    limit: 3,
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
  }),
  contacts_unfiltered: await execTool("xero_list_contacts", { limit: 3 }),
  contacts_elvex: await execTool("xero_list_contacts", { query: "Elvex", limit: 3 }),
};

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id='${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);
console.log(JSON.stringify(results, null, 2));
