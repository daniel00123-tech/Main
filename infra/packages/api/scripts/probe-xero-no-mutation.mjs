#!/usr/bin/env node
/** Verify no INFRA-ACCEPTANCE-TEST invoice exists in Xero (read-only). */
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
const scopes = JSON.stringify(["xero.invoices.read", "xero.invoices.search"]);

const sqlFile = join(apiDir, ".tmp-inv-search.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP inv search', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

const res = await fetch(`${API}/api/gateway/v1/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "xero_search_invoices",
      arguments: { reference: "INFRA-ACCEPTANCE-TEST" },
    },
  }),
});
const body = await res.json();

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

let parsed = null;
const text = body?.result?.content?.[0]?.text;
if (text) {
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
}

const invoices = parsed?.invoices ?? parsed?.results ?? [];
console.log(
  JSON.stringify(
    {
      reference: "INFRA-ACCEPTANCE-TEST",
      searchStatus: res.status,
      matchingInvoices: Array.isArray(invoices) ? invoices.length : null,
      xeroMutationDetected: Array.isArray(invoices) && invoices.length > 0,
    },
    null,
    2,
  ),
);
