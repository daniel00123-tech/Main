#!/usr/bin/env node
/**
 * Read-only Xero contact probe for Caddington acceptance prep.
 * Creates a temporary INFRA service identity, queries xero_list_contacts, then deletes the identity.
 * Does NOT create or modify any Xero records.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const COMPANY_ID = "co_caddington";
const MCP_ID = "mcp_caddington_primary";
const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, "..");

function hashServiceToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function generateServiceToken() {
  const bytes = randomBytes(24);
  const token = `infra_${Buffer.from(bytes).toString("base64url")}`;
  return { token, prefix: token.slice(0, 12), hash: hashServiceToken(token) };
}

function d1ExecuteFile(file) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", file],
    { cwd: apiDir, stdio: "inherit" },
  );
}

function escapeSql(v) {
  return String(v).replace(/'/g, "''");
}

const { token, prefix, hash } = generateServiceToken();
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const now = new Date().toISOString();
const scopes = JSON.stringify([
  "xero.contacts.search",
  "xero.contacts.read",
  "system.health",
]);

const sqlFile = join(apiDir, ".tmp-xero-probe.sql");
const sql = `
INSERT INTO service_identities (
  id, company_id, name, description, status, secret_ref,
  identity_type, token_hash, token_prefix, last_used_at, request_count,
  scopes_json, mcp_environment_id, created_at, updated_at
) VALUES (
  '${escapeSql(id)}', '${COMPANY_ID}', 'TEMP Xero contact probe', 'Auto cleanup after read-only search', 'active', NULL,
  'chatgpt', '${hash}', '${prefix}', NULL, 0,
  '${escapeSql(scopes)}', '${MCP_ID}', '${now}', '${now}'
);
`;
writeFileSync(sqlFile, sql);

try {
  d1ExecuteFile(sqlFile);
} finally {
  try {
    unlinkSync(sqlFile);
  } catch {
    /* ignore */
  }
}

async function listContacts(args) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      companyId: COMPANY_ID,
      toolName: "xero_list_contacts",
      arguments: args,
      sourceClient: "xero-contact-probe",
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const queries = ["test", "infra", "demo", "sample", "dummy", "sandbox", "internal", "training"];
const all = new Map();

const broad = await listContacts({ limit: 100 });
if (broad.status === 200 && Array.isArray(broad.body?.result?.contacts)) {
  for (const c of broad.body.result.contacts) all.set(c.ContactID, c);
} else {
  console.error("Broad list failed", broad.status, JSON.stringify(broad.body).slice(0, 500));
}

for (const q of queries) {
  const r = await listContacts({ query: q, limit: 50 });
  if (r.status === 200 && Array.isArray(r.body?.result?.contacts)) {
    for (const c of r.body.result.contacts) all.set(c.ContactID, c);
  }
}

// Cleanup temp identity
const cleanupFile = join(apiDir, ".tmp-xero-probe-cleanup.sql");
writeFileSync(cleanupFile, `DELETE FROM service_identities WHERE id = '${escapeSql(id)}';`);
try {
  d1ExecuteFile(cleanupFile);
} finally {
  try {
    unlinkSync(cleanupFile);
  } catch {
    /* ignore */
  }
}

function suitability(contact) {
  const name = String(contact.Name ?? contact.name ?? "").toLowerCase();
  const reasons = [];
  let score = 0;
  if (/test|infra|demo|sample|dummy|sandbox|training|internal|acceptance|probe/.test(name)) {
    score += 3;
    reasons.push("Name suggests test/internal record");
  }
  if (contact.ContactStatus === "ARCHIVED") {
    score += 2;
    reasons.push("Archived in Xero");
  }
  if (contact.IsCustomer === false && contact.IsSupplier === false) {
    score += 1;
    reasons.push("Neither customer nor supplier");
  }
  if (contact.IsCustomer === true) {
    score -= 2;
    reasons.push("Flagged as customer — avoid for write acceptance unless confirmed");
  }
  if (contact.IsSupplier === true) {
    score -= 1;
    reasons.push("Flagged as supplier");
  }
  if (/ltd|limited|plc|holdings|group/.test(name) && !/test|demo|sample/.test(name)) {
    score -= 2;
    reasons.push("Looks like a real trading entity name");
  }
  return { score, reasons };
}

const ranked = [...all.values()]
  .map((c) => ({ contact: c, ...suitability(c) }))
  .sort((a, b) => b.score - a.score);

console.log(JSON.stringify({ contactCount: ranked.length, candidates: ranked.slice(0, 15) }, null, 2));
