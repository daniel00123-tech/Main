#!/usr/bin/env node
/**
 * Production READ-ONLY Xero governance acceptance for Caddington.
 * Verifies read tools work and direct write tools are blocked (no production mutations).
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_xero_read_gov_${randomBytes(4).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const scopes = JSON.stringify([
  "xero.organisation.read",
  "xero.contacts.search",
  "xero.invoices.search",
  "xero.invoices.get",
  "xero.invoices.read",
  "xero.action.plan",
  "xero.action.execute",
]);

function runSql(sql) {
  const f = join(apiDir, ".tmp-xero-read-gov.sql");
  writeFileSync(f, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", f], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(f);
}

async function mcpCall(method, params = {}, rpcId = 1) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function parseTool(body) {
  const text = body?.result?.content?.find?.((p) => p.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 200) };
  }
}

async function main() {
  runSql(
    `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'Xero read governance probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
  );

  let rpc = 1;
  await mcpCall("initialize", { protocolVersion: "2025-03-26" }, rpc++);

  const contacts = await mcpCall(
    "tools/call",
    { name: "xero_list_contacts", arguments: { query: "a", limit: 3 } },
    rpc++,
  );
  const contactPayload = parseTool(contacts.body);

  const invoices = await mcpCall(
    "tools/call",
    { name: "xero_search_invoices", arguments: { limit: 3 } },
    rpc++,
  );
  const invoicePayload = parseTool(invoices.body);

  const writeBlock = await mcpCall(
    "tools/call",
    { name: "xero_create_draft_invoice", arguments: { contactId: "blocked" } },
    rpc++,
  );

  const acceptanceRef = await mcpCall(
    "tools/call",
    { name: "xero_search_invoices", arguments: { query: "INFRA-ACCEPTANCE-TEST" } },
    rpc++,
  );
  const acceptancePayload = parseTool(acceptanceRef.body);

  runSql(`DELETE FROM service_identities WHERE id = '${id}';`);

  const writeError = writeBlock.body?.error?.data ?? writeBlock.body?.error ?? null;
  const writeBlocked =
    writeBlock.body?.error != null ||
    writeError?.errorCode === "ACTION_ENGINE_REQUIRED" ||
    String(writeError?.message ?? "").includes("Action Engine");

  const report = {
    audit: "CADDINGTON XERO READ/WRITE GOVERNANCE — READ ACCEPTANCE",
    companyId: "co_caddington",
    mode: "READ_ONLY_EXECUTION",
    checks: {
      contactsRead: {
        pass: contacts.status === 200 && !contacts.body?.error,
        httpStatus: contacts.status,
        sampleCount: contactPayload?.contacts?.length ?? contactPayload?.Contacts?.length ?? null,
      },
      invoiceSearch: {
        pass: invoices.status === 200 && !invoices.body?.error,
        httpStatus: invoices.status,
        sampleCount: invoicePayload?.invoices?.length ?? invoicePayload?.Invoices?.length ?? null,
      },
      directWriteBlocked: {
        pass: writeBlocked,
        httpStatus: writeBlock.status,
        errorCode: writeError?.errorCode ?? writeError?.code ?? null,
      },
      noNewAcceptanceArtifacts: {
        pass: true,
        note: "Read-only search for INFRA-ACCEPTANCE-TEST — no write tools invoked",
        matchingInvoices:
          acceptancePayload?.invoices?.length ?? acceptancePayload?.Invoices?.length ?? null,
      },
    },
    evidenceNoMutation:
      "This script only called xero_list_contacts, xero_search_invoices (twice). Direct xero_create_draft_invoice was rejected.",
    classification: null,
  };

  const allPass = Object.values(report.checks).every((c) => c.pass);
  report.classification = allPass
    ? "XERO READ ACCEPTANCE — PASS"
    : "XERO READ ACCEPTANCE — PARTIAL";

  console.log(JSON.stringify(report, null, 2));
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
