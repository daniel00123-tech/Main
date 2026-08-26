#!/usr/bin/env node
/** Read-back verification for an existing acceptance invoice (no writes). */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const INVOICE_ID = process.env.INVOICE_ID ?? "95880e90-5bde-4b39-99d9-a0b0203cf37a";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCOPES = JSON.stringify([
  "xero.invoices.get",
  "xero.action.read",
  "system.health",
]);

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const sqlFile = join(apiDir, ".tmp-readback.sql");

writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP readback', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${SCOPES.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

const res = await fetch(MCP, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "xero_get_invoice", arguments: { invoiceId: INVOICE_ID } },
  }),
});
const body = await res.json();
const text = body?.result?.content?.find((p) => p.type === "text")?.text;
const payload = text ? JSON.parse(text) : null;
const invoice = payload?.invoice;

execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", `DELETE FROM service_identities WHERE id='${id}'`], {
  cwd: apiDir,
  stdio: "pipe",
});
try {
  unlinkSync(sqlFile);
} catch {
  /* ignore */
}

const report = {
  invoiceId: INVOICE_ID,
  ok: Boolean(
    invoice?.Status === "DRAFT" &&
      invoice?.InvoiceNumber === "INV-0021" &&
      invoice?.Reference === "123" &&
      Number(invoice?.Total) === 1 &&
      invoice?.LineItems?.[0]?.Description === "test" &&
      invoice?.LineItems?.[0]?.TaxType === "NONE",
  ),
  invoice,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
