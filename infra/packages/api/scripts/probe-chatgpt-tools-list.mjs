#!/usr/bin/env node
/** Probe production ChatGPT identity tools/list — never prints tokens. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// Query production ChatGPT identity scopes (not token)
const identity = execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "infra-control-plane",
    "--remote",
    "--command",
    "SELECT id, token_prefix, scopes_json, mcp_environment_id FROM service_identities WHERE company_id = 'co_caddington' AND identity_type = 'chatgpt' AND status = 'active' ORDER BY created_at ASC LIMIT 3",
    "--json",
  ],
  { cwd: apiDir, encoding: "utf8" },
);
const identities = JSON.parse(identity)[0]?.results ?? [];

// Temp probe with scopes matching production ChatGPT identity pattern
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");

// Use broad read scopes like production ChatGPT identity
const scopes = JSON.stringify([
  "system.health",
  "knowledge.search",
  "knowledge.read",
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
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.cancel",
  "xero.action.list",
]);

const sqlFile = join(apiDir, ".tmp-chatgpt-list.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP ChatGPT scope probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function mcp(method, params, rpcId) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

await mcp("initialize", { protocolVersion: "2025-03-26" }, 1);
const list = await mcp("tools/list", {}, 2);
const tools = (list.body?.result?.tools ?? []).map((t) => t.name);

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

const xeroReads = [
  "xero_get_organisation",
  "xero_list_contacts",
  "xero_get_contact",
  "xero_search_invoices",
  "xero_get_invoice",
  "xero_list_overdue_invoices",
  "xero_list_payments",
  "xero_list_accounts",
  "xero_list_bank_transactions",
  "xero_profit_and_loss",
  "xero_balance_sheet",
  "xero_aged_receivables",
  "xero_sales_summary",
  "xero_top_customers",
];

console.log(
  JSON.stringify(
    {
      productionChatGptIdentities: identities.map((i) => ({
        id: i.id,
        tokenPrefix: i.token_prefix,
        mcpEnvironmentId: i.mcp_environment_id,
      })),
      activeProductionIdentityPrefix: "infra_1HS3Nn (unchanged)",
      infraToolsList: {
        status: list.status,
        error: list.body?.error ?? null,
        totalTools: tools.length,
        toolNames: tools,
        knowledgeTools: {
          search: tools.includes("search"),
          fetch: tools.includes("fetch"),
          search_company_knowledge: tools.includes("search_company_knowledge"),
          get_knowledge_document: tools.includes("get_knowledge_document"),
          system_health: tools.includes("system_health"),
          database_summary: tools.includes("database_summary"),
        },
        xeroReadToolsPresent: Object.fromEntries(xeroReads.map((n) => [n, tools.includes(n)])),
        xeroReadToolsCount: tools.filter((n) => n.startsWith("xero_")).length,
        actionTools: tools.filter((n) => n.includes("action") || n.startsWith("plan_")),
        writeToolsHidden: !tools.includes("xero_create_draft_invoice"),
      },
    },
    null,
    2,
  ),
);
