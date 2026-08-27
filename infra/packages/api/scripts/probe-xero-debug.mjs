#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { token, prefix, hash } = (() => {
  const bytes = randomBytes(24);
  const t = `infra_${Buffer.from(bytes).toString("base64url")}`;
  return {
    token: t,
    prefix: t.slice(0, 12),
    hash: createHash("sha256").update(t).digest("hex"),
  };
})();
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const now = new Date().toISOString();
const scopes = JSON.stringify([
  "xero.contacts.search",
  "xero.contacts.read",
  "xero.organisation.read",
  "system.health",
]);
const sqlFile = join(apiDir, ".tmp-probe-debug.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${prefix}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', '${now}', '${now}');`,
);
execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile],
  { cwd: apiDir, stdio: "inherit" },
);

async function call(tool, args = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      companyId: "co_caddington",
      toolName: tool,
      arguments: args,
      sourceClient: "probe",
    }),
  });
  const text = await res.text();
  console.log("\n===", tool, res.status, "===");
  console.log(text.slice(0, 2000));
}

await call("system_health");
await call("xero_profit_and_loss", {
  fromDate: "2025-08-01",
  toDate: "2025-08-25",
});
await call("xero_get_organisation");
await call("xero_list_contacts", { query: "test", limit: 20 });
await call("xero_list_contacts", { limit: 20 });

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id='${id}';`);
execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile],
  { cwd: apiDir, stdio: "inherit" },
);
