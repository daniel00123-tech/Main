#!/usr/bin/env node
/**
 * Create a short-lived INFRA acceptance service identity for production probing.
 * Does not rotate or modify the active ChatGPT identity token.
 */
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, "..");

function d1ExecuteFile(file, remote = true) {
  const flag = remote ? "--remote" : "--local";
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", flag, "--file", file],
    { cwd: apiDir, stdio: "inherit" },
  );
}

function escapeSql(value) {
  return value.replace(/'/g, "''");
}

const tokenBytes = randomBytes(24);
let binary = "";
for (const byte of tokenBytes) binary += String.fromCharCode(byte);
const token = `infra_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const tokenPrefix = token.slice(0, 12);
const now = new Date().toISOString();
const id = `svc_accept_${Date.now()}`;

const scopes = [
  "knowledge.search",
  "knowledge.read",
  "system.health",
  "xero.organisation.read",
  "xero.contacts.read",
  "xero.contacts.search",
  "xero.invoices.read",
  "xero.invoices.search",
  "xero.invoices.get",
  "xero.payments.read",
  "xero.accounts.read",
  "xero.bank_transactions.read",
  "xero.reports.pnl.read",
  "xero.reports.balance_sheet.read",
  "xero.reports.aged.read",
  "xero.sales.summary",
  "xero.top_customers",
  "xero.health",
  "xero.token_refresh",
];

const sqlFile = join(apiDir, ".tmp-acceptance-identity.sql");
const sql = `
INSERT INTO service_identities (
  id, company_id, name, description, status, secret_ref,
  identity_type, token_hash, token_prefix, last_used_at, request_count,
  scopes_json, mcp_environment_id, created_at, updated_at
) VALUES (
  '${escapeSql(id)}',
  'co_caddington',
  'INFRA Xero acceptance probe',
  'Temporary acceptance identity for production Xero MCP verification',
  'active',
  NULL,
  'automation',
  '${tokenHash}',
  '${escapeSql(tokenPrefix)}',
  NULL,
  0,
  '${JSON.stringify(scopes).replace(/'/g, "''")}',
  'mcp_caddington_primary',
  '${now}',
  '${now}'
);
`;

writeFileSync(sqlFile, sql);
try {
  d1ExecuteFile(sqlFile);
  process.stdout.write(`${token}\n${id}\n`);
} finally {
  try {
    unlinkSync(sqlFile);
  } catch {
    // ignore
  }
}
