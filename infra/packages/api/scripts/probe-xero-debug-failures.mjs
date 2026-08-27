#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const t = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const prefix = t.slice(0, 12);
const sid = `svc_dbg_${randomBytes(4).toString("hex")}`;
const now = new Date().toISOString();
const scopes = JSON.stringify([
  "xero.invoices.read",
  "xero.payments.read",
  "xero.sales.summary",
  "xero.top_customers",
  "xero.reports.aged.read",
  "xero.tax_rates.read",
  "xero.vat.capability",
  "xero.top_suppliers",
]);
const sql = join(apiDir, ".tmp-dbg.sql");
writeFileSync(
  sql,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${sid}', 'co_caddington', 'dbg', 'dbg', 'active', NULL, 'chatgpt', '${createHash("sha256").update(t).digest("hex")}', '${prefix}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', '${now}', '${now}');`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sql], {
  cwd: apiDir,
  stdio: "inherit",
});
unlinkSync(sql);

async function ex(tool, args = {}) {
  const r = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      companyId: "co_caddington",
      toolName: tool,
      arguments: args,
      sourceClient: "dbg",
    }),
  });
  return { status: r.status, body: await r.json() };
}

for (const [tool, args] of [
  ["xero_search_invoices", { unpaidOnly: true, invoiceType: "ACCREC", limit: 5 }],
  ["xero_top_suppliers", { fromDate: "2026-07-01", toDate: "2026-07-31", limit: 5 }],
  ["xero_vat_capability", {}],
  ["xero_sales_summary", { fromDate: "2026-07-01", toDate: "2026-07-31" }],
]) {
  const r = await ex(tool, args);
  console.log("---", tool, r.status, r.body?.error ?? r.body?.code ?? "ok");
  if (tool === "xero_sales_summary") {
    console.log("first tx date", r.body?.result?.transactions?.[0]?.date);
  }
}

writeFileSync(join(apiDir, ".tmp-dbg-c.sql"), `DELETE FROM service_identities WHERE id='${sid}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", join(apiDir, ".tmp-dbg-c.sql")], {
  cwd: apiDir,
  stdio: "inherit",
});
unlinkSync(join(apiDir, ".tmp-dbg-c.sql"));
