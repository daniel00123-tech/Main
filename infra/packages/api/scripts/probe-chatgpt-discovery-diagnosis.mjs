#!/usr/bin/env node
/**
 * Diagnose ChatGPT MCP discovery — simulates ChatGPT headers and compares catalogue.
 * Uses production identity scopes (not the secret token). Never prints tokens.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const scopeRow = JSON.parse(
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "infra-control-plane",
      "--remote",
      "--command",
      "SELECT scopes_json FROM service_identities WHERE token_prefix = 'infra_1HS3Nn' AND status = 'active'",
      "--json",
    ],
    { cwd: apiDir, encoding: "utf8" },
  ),
)[0]?.results?.[0]?.scopes_json ?? "[]";

const PRODUCTION_SCOPES = JSON.parse(scopeRow);

const ACTION_TOOLS = [
  "plan_xero_draft_invoice",
  "dry_run_action_plan",
  "get_action_plan",
  "confirm_action_plan",
  "cancel_action_plan",
  "list_pending_actions",
];

async function runProbe(label, headers) {
  const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
  const id = `svc_probe_${randomBytes(8).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const sqlFile = join(apiDir, ".tmp-chatgpt-discovery.sql");

  writeFileSync(
    sqlFile,
    `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP ${label}', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${JSON.stringify(PRODUCTION_SCOPES).replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
  );
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });

  async function rpc(method, params, rpcId) {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} }),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let body;
    if (contentType.includes("event-stream")) {
      const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
      body = dataLine ? JSON.parse(dataLine.slice(6)) : { raw: text.slice(0, 500) };
    } else {
      body = JSON.parse(text);
    }
    return { status: res.status, contentType, body };
  }

  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} }, 1);
  await rpc("notifications/initialized", {}, "n1");
  const list = await rpc("tools/list", {}, 2);
  const tools = list.body?.result?.tools ?? [];
  const names = tools.map((t) => t.name);

  writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(sqlFile);

  return {
    label,
    initializeProtocol: init.body?.result?.protocolVersion ?? null,
    contentType: list.contentType,
    toolCount: names.length,
    toolNames: names,
    actionToolsPresent: Object.fromEntries(ACTION_TOOLS.map((n) => [n, names.includes(n)])),
    planToolSchema: tools.find((t) => t.name === "plan_xero_draft_invoice")?.inputSchema ?? null,
    planToolAnnotations: tools.find((t) => t.name === "plan_xero_draft_invoice")?.annotations ?? null,
  };
}

const jsonProbe = await runProbe("chatgpt-json", {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "User-Agent": "openai-mcp/1.0",
});
const sseOnlyProbe = await runProbe("chatgpt-sse-only", {
  Accept: "text/event-stream",
  "Content-Type": "application/json",
});

console.log(
  JSON.stringify(
    {
      endpoint: API,
      productionIdentityPrefix: "infra_1HS3Nn",
      productionScopeCount: PRODUCTION_SCOPES.length,
      hasActionScopes: PRODUCTION_SCOPES.filter((s) => String(s).startsWith("xero.action.")),
      probes: [jsonProbe, sseOnlyProbe],
      auditEvidence: {
        note: "Production audit at 2026-08-25T21:55:10Z shows Caddington Holdings ChatGPT received 28 tools including all action tools",
      },
    },
    null,
    2,
  ),
);
