#!/usr/bin/env node
/**
 * Server-side HT/EL routing probe.
 * Never prints secrets. Never runs Caddington knowledge search.
 *
 * Usage (after HT_MCP_AUTH_TOKEN / EL_MCP_AUTH_TOKEN are on infra-api):
 *   node scripts/probe-ht-el-routing.mjs
 */
const API = "https://infra-api.daniel-dwyer123.workers.dev";

async function json(path) {
  const res = await fetch(`${API}${path}`);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

const health = await json("/health");
const ready = await json("/ready");
console.log("infra /health", health.status);
console.log("infra /ready", ready.status);

for (const host of [
  "https://ht-business-mcp.daniel-dwyer123.workers.dev",
  "https://el-business-mcp.daniel-dwyer123.workers.dev",
  "https://caddington-mcp.daniel-dwyer123.workers.dev",
]) {
  const h = await fetch(`${host}/health`);
  const m = await fetch(`${host}/mcp`, { method: "POST" });
  console.log(host.replace("https://", ""), "health", h.status, "mcp_unauth", m.status);
}

if (!process.env.HT_SERVICE_TOKEN || !process.env.EL_SERVICE_TOKEN) {
  console.log(
    "skip_authenticated_facade: set HT_SERVICE_TOKEN and EL_SERVICE_TOKEN (INFRA service identities, not MCP tokens) to prove initialize/tools/list/system_health",
  );
  process.exit(0);
}

async function mcpCall(token, method, params = {}) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

for (const [label, token] of [
  ["HT", process.env.HT_SERVICE_TOKEN],
  ["EL", process.env.EL_SERVICE_TOKEN],
]) {
  const init = await mcpCall(token, "initialize", { protocolVersion: "2025-03-26" });
  const list = await mcpCall(token, "tools/list", {});
  const healthCall = await mcpCall(token, "tools/call", {
    name: "system_health",
    arguments: {},
  });
  const tools = list.body?.result?.tools?.map((t) => t.name) ?? [];
  console.log(label, {
    initialize: init.status,
    tools_list: list.status,
    tools,
    system_health: healthCall.status,
  });
}
