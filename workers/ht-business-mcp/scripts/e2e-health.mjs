#!/usr/bin/env node
/**
 * HT Business MCP deployment smoke test.
 * Requires: HT_MCP_URL, HT_MCP_AUTH_TOKEN
 */
const baseUrl = process.env.HT_MCP_URL?.replace(/\/$/, "") ??
  "https://ht-business-mcp.daniel-dwyer123.workers.dev";
const mcpToken = process.env.HT_MCP_AUTH_TOKEN ?? process.env.MCP_AUTH_TOKEN;

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`OK  ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function mcpCall(toolName, args = {}) {
  if (!mcpToken) throw new Error("HT_MCP_AUTH_TOKEN required for MCP tests");
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mcpToken}`,
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  if (!response.ok) {
    throw new Error(`${toolName} HTTP ${response.status}`);
  }
  return response.text();
}

await check("GET /health public", async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  if (!body.ok) throw new Error("health not ok");
  if (body.company !== "HT Business") throw new Error(`company=${body.company}`);
  if (body.mcpVersion !== "0.2.1") throw new Error(`mcpVersion=${body.mcpVersion}`);
});

await check("GET /status unauthenticated rejected", async () => {
  const res = await fetch(`${baseUrl}/status`);
  if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
});

await check("MCP unauthenticated rejected", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
});

await check("MCP incorrect token rejected", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer invalid-token",
    },
    body: "{}",
  });
  if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
});

if (mcpToken) {
  await check("GET /status authenticated", async () => {
    const res = await fetch(`${baseUrl}/status`, {
      headers: { Authorization: `Bearer ${mcpToken}` },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`status ${res.status}`);
    if (body.structuredData?.dataStatus !== "populated") {
      throw new Error(`dataStatus=${body.structuredData?.dataStatus}`);
    }
  });

  await check("MCP system_health", async () => {
    const text = await mcpCall("system_health");
    if (!text.includes("HT Business")) throw new Error("missing company");
    if (!text.includes("0.2.1")) throw new Error("missing version");
  });

  await check("MCP database_summary", async () => {
    const text = await mcpCall("database_summary");
    if (!text.includes("customers")) throw new Error("missing customers table");
  });

  await check("MCP query_business_data analytics", async () => {
    const text = await mcpCall("query_business_data", {
      sql: "SELECT COUNT(*) AS completed_jobs FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy'",
    });
    if (!text.includes("328")) throw new Error("unexpected completed_jobs count");
  });

  await check("MCP search_company_knowledge not_configured", async () => {
    const text = await mcpCall("search_company_knowledge", { query: "policy" });
    if (!text.includes("not_configured")) throw new Error("expected not_configured");
  });

  await check("MCP get_knowledge_document not_configured", async () => {
    const text = await mcpCall("get_knowledge_document", { document_id: 1 });
    if (!text.includes("not_configured")) throw new Error("expected not_configured");
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
