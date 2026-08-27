#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const t = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const sid = `svc_dbg_${randomBytes(4).toString("hex")}`;
const scopes = '["xero.organisation.read","xero.contacts.read","xero.contacts.search","xero.invoices.read","xero.invoices.search","xero.invoices.get","xero.payments.read","xero.accounts.read","xero.bank_transactions.read","xero.reports.pnl.read","xero.reports.balance_sheet.read","xero.reports.aged.read","xero.sales.summary","xero.top_customers","xero.top_suppliers","xero.list_tax_rates","xero.vat.capability"]';
const now = new Date().toISOString();
const sql = join(apiDir, ".tmp-leak.sql");
writeFileSync(sql, `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${sid}', 'co_caddington', 'leak', 'leak', 'active', NULL, 'chatgpt', '${createHash("sha256").update(t).digest("hex")}', '${t.slice(0,12)}', NULL, 0, '${scopes}', 'mcp_caddington_primary', '${now}', '${now}');`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sql], { cwd: apiDir, stdio: "pipe" });
unlinkSync(sql);

function findDotNetDates(value, path = "") {
  const hits = [];
  if (typeof value === "string" && /^\/Date\(\d+/.test(value)) hits.push(path + "=" + value.slice(0, 30));
  else if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findDotNetDates(v, `${path}[${i}]`)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) hits.push(...findDotNetDates(v, path ? `${path}.${k}` : k));
  }
  return hits;
}

async function ex(tool, args = {}) {
  const r = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: "co_caddington", toolName: tool, arguments: args, sourceClient: "leak" }),
  });
  return { status: r.status, body: await r.json() };
}

const probes = [
  ["xero_sales_summary", { fromDate: "2026-07-01", toDate: "2026-07-31" }],
  ["xero_list_overdue_invoices", { effectiveDate: "2026-08-27", limit: 10 }],
  ["xero_list_payments", { since: "2026-07-01", toDate: "2026-07-31", direction: "customer_receipt" }],
  ["xero_aged_receivables", { reportType: "receivables", date: "2026-08-27" }],
  ["xero_top_suppliers", { fromDate: "2026-07-01", toDate: "2026-07-31" }],
  ["xero_vat_capability", {}],
];

for (const [tool, args] of probes) {
  const r = await ex(tool, args);
  const hits = findDotNetDates(r.body?.result ?? r.body);
  console.log(tool, r.status, hits.length ? hits.slice(0, 3).join("; ") : "clean");
}

writeFileSync(join(apiDir, ".tmp-leak-c.sql"), `DELETE FROM service_identities WHERE id='${sid}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", join(apiDir, ".tmp-leak-c.sql")], { cwd: apiDir, stdio: "pipe" });
unlinkSync(join(apiDir, ".tmp-leak-c.sql"));
