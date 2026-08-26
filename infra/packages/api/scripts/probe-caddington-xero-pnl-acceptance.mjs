#!/usr/bin/env node
/**
 * Production P&L acceptance probe via INFRA MCP facade.
 */
const API = "https://infra-api.daniel-dwyer123.workers.dev";

const PERIODS = [
  { label: "May 2026", fromDate: "2026-05-01", toDate: "2026-05-31" },
  { label: "June 2026", fromDate: "2026-06-01", toDate: "2026-06-30" },
  { label: "July 2026", fromDate: "2026-07-01", toDate: "2026-07-31" },
  { label: "August 1-25 2026", fromDate: "2026-08-01", toDate: "2026-08-25" },
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
  return res.json();
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
    console.error("Set CADDINGTON_SERVICE_TOKEN");
    process.exit(1);
  }

  await mcpCall(token, "initialize", { protocolVersion: "2025-03-26" });

  const results = [];
  let id = 2;
  for (const period of PERIODS) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await mcpCall(
      token,
      "tools/call",
      {
        name: "xero_profit_and_loss",
        arguments: { fromDate: period.fromDate, toDate: period.toDate },
      },
      id,
    );
    id += 1;
    const payload = parseToolText(response);
    const parsed = payload?.parsed?.periods?.[0] ?? null;
    results.push({
      label: period.label,
      fromDate: period.fromDate,
      toDate: period.toDate,
      ok: !response.error,
      error: response.error?.message ?? null,
      currencyCode: payload?.currencyCode ?? payload?.parsed?.currencyCode ?? null,
      revenue: parsed?.revenue ?? null,
      costOfSales: parsed?.costOfSales ?? null,
      grossProfit: parsed?.grossProfit ?? null,
      operatingExpenses: parsed?.operatingExpenses ?? null,
      netProfit: parsed?.netProfit ?? null,
    });
  }

  console.log(JSON.stringify({ periods: results }, null, 2));
  if (results.some((row) => !row.ok)) process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
