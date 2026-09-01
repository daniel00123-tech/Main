#!/usr/bin/env node
/**
 * EL Business MCP deployment smoke test.
 * Requires: EL_MCP_URL, EL_MCP_AUTH_TOKEN (optional: EL_ADMIN_TOKEN)
 */
const baseUrl = process.env.EL_MCP_URL?.replace(/\/$/, "");
const mcpToken = process.env.EL_MCP_AUTH_TOKEN;
const adminToken = process.env.EL_ADMIN_TOKEN;

if (!baseUrl) {
  console.error("EL_MCP_URL is required");
  process.exit(1);
}

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
  if (!mcpToken) throw new Error("EL_MCP_AUTH_TOKEN required for MCP tests");
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
  const text = await response.text();
  return text;
}

await check("GET /health", async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  if (!body.ok) throw new Error("health not ok");
  if (body.company !== "EL Business") throw new Error(`company=${body.company}`);
  if (body.coreVersion !== "1.0.0") throw new Error(`coreVersion=${body.coreVersion}`);
  if (body.mcpVersion !== "1.0.0") throw new Error(`mcpVersion=${body.mcpVersion}`);
});

await check("GET /status", async () => {
  const res = await fetch(`${baseUrl}/status`);
  const body = await res.json();
  if (body.knowledge?.status !== "not_configured") {
    throw new Error(`knowledge.status=${body.knowledge?.status}`);
  }
  if (body.structuredData?.dataStatus !== "empty") {
    throw new Error(`structuredData.dataStatus=${body.structuredData?.dataStatus}`);
  }
});

await check("MCP unauthenticated rejected", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
});

if (mcpToken) {
  await check("MCP system_health", async () => {
    const text = await mcpCall("system_health");
    if (!text.includes("EL Business")) throw new Error("missing company in response");
    if (!text.includes("1.0.0")) throw new Error("missing version in response");
  });

  await check("MCP database_summary", async () => {
    const text = await mcpCall("database_summary");
    if (!text.includes("connector_registry")) throw new Error("missing connectors");
  });

  await check("MCP query_business_data empty", async () => {
    const text = await mcpCall("query_business_data", {
      sql: "SELECT code, label, status FROM connector_registry",
    });
    if (!text.includes("bigchange")) throw new Error("missing connector rows");
  });

  await check("MCP search_company_knowledge not_configured", async () => {
    const text = await mcpCall("search_company_knowledge", {
      query: "test policy",
    });
    if (!text.includes("not_configured")) throw new Error("expected not_configured");
  });

  await check("MCP get_knowledge_document not_configured", async () => {
    const text = await mcpCall("get_knowledge_document", { document_id: 1 });
    if (!text.includes("not_configured")) throw new Error("expected not_configured");
  });
}

if (adminToken) {
  await check("GET /admin/connectors", async () => {
    const res = await fetch(`${baseUrl}/admin/connectors`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.registry) || body.registry.length < 6) {
      throw new Error("connector registry incomplete");
    }
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
