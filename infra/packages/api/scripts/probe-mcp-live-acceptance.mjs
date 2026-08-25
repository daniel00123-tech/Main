#!/usr/bin/env node
/** Extended MCP acceptance including system_health via tools/call — never prints tokens. */
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
const scopes = JSON.stringify([
  "system.health",
  "knowledge.search",
  "knowledge.read",
  "xero.organisation.read",
  "xero.sales.summary",
  "xero.reports.pnl.read",
]);

const sqlFile = join(apiDir, ".tmp-ext-acceptance.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP extended acceptance', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function mcpCall(method, params, rpcId) {
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

function toolText(body) {
  const text = body?.result?.content?.find?.((p) => p.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

await mcpCall("initialize", { protocolVersion: "2025-03-26" }, 1);
const health = await mcpCall("tools/call", { name: "system_health", arguments: {} }, 2);
const knowledge = await mcpCall(
  "tools/call",
  { name: "search_company_knowledge", arguments: { query: "health", limit: 1 } },
  3,
);
const org = await mcpCall("tools/call", { name: "xero_get_organisation", arguments: {} }, 4);
const sales = await mcpCall(
  "tools/call",
  { name: "xero_sales_summary", arguments: { fromDate: "2026-07-01", toDate: "2026-07-31" } },
  5,
);
const pnl = await mcpCall(
  "tools/call",
  { name: "xero_profit_and_loss", arguments: { fromDate: "2026-07-01", toDate: "2026-07-31" } },
  6,
);

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      system_health: {
        status: health.status,
        ok: health.status === 200 && !health.body?.error,
        payload: toolText(health.body),
      },
      knowledge_search: {
        status: knowledge.status,
        ok: knowledge.status === 200 && !knowledge.body?.error,
      },
      xero_get_organisation: {
        status: org.status,
        ok: org.status === 200 && !org.body?.error,
        organisationName: toolText(org.body)?.organisationName ?? null,
      },
      xero_sales_summary: {
        status: sales.status,
        ok: sales.status === 200 && !sales.body?.error,
      },
      xero_profit_and_loss: {
        status: pnl.status,
        ok: pnl.status === 200 && !pnl.body?.error,
      },
    },
    null,
    2,
  ),
);
