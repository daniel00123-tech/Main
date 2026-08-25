#!/usr/bin/env node
/**
 * Production acceptance probe for Caddington Xero via INFRA MCP facade.
 * Never prints secrets. Requires CADDINGTON_SERVICE_TOKEN (existing ChatGPT identity).
 */
const API = "https://infra-api.daniel-dwyer123.workers.dev";
const REQUIRED_XERO_TOOLS = [
  "xero_sales_summary",
  "xero_top_customers",
  "xero_profit_and_loss",
  "xero_search_invoices",
  "xero_get_invoice",
  "xero_list_payments",
  "xero_list_bank_transactions",
];

async function mcpCall(token, method, params = {}, id = 1) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function parseToolText(body) {
  const text = body?.result?.content?.find?.((part) => part.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main() {
  const token = process.env.CADDINGTON_SERVICE_TOKEN?.trim();
  if (!token) {
    console.error(
      "Set CADDINGTON_SERVICE_TOKEN to the active Caddington ChatGPT service identity (token not rotated).",
    );
    process.exit(1);
  }

  const init = await mcpCall(token, "initialize", { protocolVersion: "2025-03-26" });
  const list = await mcpCall(token, "tools/list", {}, 2);
  const toolNames = list.body?.result?.tools?.map((tool) => tool.name) ?? [];
  const missing = REQUIRED_XERO_TOOLS.filter((name) => !toolNames.includes(name));

  console.log(
    JSON.stringify(
      {
        initializeStatus: init.status,
        toolsListStatus: list.status,
        toolCount: toolNames.length,
        xeroToolsPresent: REQUIRED_XERO_TOOLS.filter((name) => toolNames.includes(name)),
        missingRequiredXeroTools: missing,
      },
      null,
      2,
    ),
  );

  if (missing.length > 0) {
    process.exit(2);
  }

  const sales = await mcpCall(
    token,
    "tools/call",
    {
      name: "xero_sales_summary",
      arguments: { fromDate: "2026-07-01", toDate: "2026-07-31" },
    },
    3,
  );
  const salesPayload = parseToolText(sales.body);
  console.log(
    JSON.stringify(
      {
        xero_sales_summary: {
          status: sales.status,
          organisationName: salesPayload?.organisationName ?? null,
          summary: salesPayload?.summary ?? salesPayload,
        },
      },
      null,
      2,
    ),
  );

  const top = await mcpCall(
    token,
    "tools/call",
    {
      name: "xero_top_customers",
      arguments: { fromDate: "2026-07-01", toDate: "2026-07-31", limit: 3 },
    },
    4,
  );
  const topPayload = parseToolText(top.body);
  console.log(
    JSON.stringify(
      {
        xero_top_customers: {
          status: top.status,
          organisationName: topPayload?.organisationName ?? null,
          customers: topPayload?.customers ?? topPayload,
        },
      },
      null,
      2,
    ),
  );

  if (sales.status !== 200 || top.status !== 200) {
    process.exit(3);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
