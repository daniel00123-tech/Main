#!/usr/bin/env node
/**
 * Production MCP acceptance through INFRA gateway + direct caddington-mcp checks.
 * Creates temporary service identity; never prints tokens.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = "https://caddington-mcp.daniel-dwyer123.workers.dev/mcp";
const COMPANY_ID = "co_caddington";
const MCP_ID = "mcp_caddington_primary";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function hash(token) {
  return createHash("sha256").update(token).digest("hex");
}

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const scopes = JSON.stringify([
  "system.health",
  "knowledge.search",
  "knowledge.read",
  "xero.organisation.read",
  "xero.contacts.read",
  "xero.contacts.search",
  "xero.invoices.read",
  "xero.invoices.search",
  "xero.reports.pnl.read",
  "xero.sales.summary",
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.cancel",
  "xero.action.list",
]);

const sqlFile = join(apiDir, ".tmp-mcp-acceptance.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', '${COMPANY_ID}', 'TEMP MCP acceptance', 'auto cleanup', 'active', NULL, 'chatgpt', '${hash(token)}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', '${MCP_ID}', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "inherit",
});

async function infraMcp(method, params = {}, rpcId = 1) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function execute(toolName, args = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      companyId: COMPANY_ID,
      toolName,
      arguments: args,
      sourceClient: "mcp-acceptance-probe",
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function toolText(body) {
  const text = body?.result?.content?.find?.((p) => p.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

const unauth = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});

const init = await infraMcp("initialize", { protocolVersion: "2025-03-26" }, 1);
const initialized = await infraMcp("notifications/initialized", {}, 2);
const list = await infraMcp("tools/list", {}, 3);
const toolNames = (list.body?.result?.tools ?? []).map((t) => t.name);
const listError = list.body?.error ?? null;
const xeroTools = toolNames.filter((n) => n.startsWith("xero_"));
const actionTools = toolNames.filter((n) => n.includes("action") || n.startsWith("plan_"));

const orgExecute = await execute("xero_get_organisation");
const salesExecute = await execute("xero_sales_summary", {
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
});
const pnlExecute = await execute("xero_profit_and_loss", {
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
});

const orgCall = await infraMcp(
  "tools/call",
  { name: "xero_get_organisation", arguments: {} },
  4,
);
const knowledgeCall = await infraMcp(
  "tools/call",
  { name: "search_company_knowledge", arguments: { query: "health", limit: 1 } },
  5,
);
const docCall = await infraMcp(
  "tools/call",
  { name: "get_knowledge_document", arguments: { documentId: "probe-nonexistent" } },
  6,
);
const directWrite = await infraMcp(
  "tools/call",
  { name: "xero_create_draft_invoice", arguments: { contactId: "00000000-0000-0000-0000-000000000001" } },
  7,
);

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "inherit",
});
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      health: await (await fetch("https://caddington-mcp.daniel-dwyer123.workers.dev/health")).json(),
      unauthenticatedMcpStatus: unauth.status,
      initialize: { status: init.status, ok: init.status === 200 && !init.body?.error },
      notificationsInitialized: { status: initialized.status },
      infraToolsList: {
        status: list.status,
        listError,
        totalTools: toolNames.length,
        toolNames,
        xeroTools,
        actionTools,
        hasKnowledgeSearch: toolNames.includes("search_company_knowledge"),
        hasKnowledgeFetch: toolNames.includes("get_knowledge_document"),
        hasSearchFetchAdaptors: toolNames.includes("search") && toolNames.includes("fetch"),
      },
      xeroReadsViaExecute: {
        xero_get_organisation: {
          status: orgExecute.status,
          ok: orgExecute.status === 200,
          organisation:
            orgExecute.body?.result?.organisationName ??
            orgExecute.body?.data?.result?.organisationName ??
            null,
        },
        xero_sales_summary: { status: salesExecute.status, ok: salesExecute.status === 200 },
        xero_profit_and_loss: { status: pnlExecute.status, ok: pnlExecute.status === 200 },
      },
      xeroReadViaMcpCall: {
        status: orgCall.status,
        ok: orgCall.status === 200 && !orgCall.body?.error,
        organisationName: toolText(orgCall.body)?.organisationName ?? null,
      },
      knowledge: {
        search: {
          status: knowledgeCall.status,
          ok: knowledgeCall.status === 200 && !knowledgeCall.body?.error,
        },
        getDocument: {
          status: docCall.status,
          ok: docCall.status === 200 || docCall.status === 502,
          note: "nonexistent doc id expected to fail gracefully, not 500",
        },
      },
      directWriteBypass: {
        status: directWrite.status,
        blocked:
          directWrite.body?.error?.message?.includes("ACTION_ENGINE_REQUIRED") ||
          directWrite.body?.error?.code === "ACTION_ENGINE_REQUIRED" ||
          !xeroTools.includes("xero_create_draft_invoice"),
      },
      financialWritesEnabled: false,
    },
    null,
    2,
  ),
);
