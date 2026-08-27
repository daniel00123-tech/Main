#!/usr/bin/env node
/**
 * Inspect live July Xero invoices/credit notes for classification (no secrets printed).
 */
const API = "https://infra-api.daniel-dwyer123.workers.dev";

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
  if (!text) return body?.result ?? body;
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

  const search = await mcpCall(
    token,
    "tools/call",
    {
      name: "xero_search_invoices",
      arguments: { fromDate: "2026-07-01", toDate: "2026-07-31", limit: 100 },
    },
    2,
  );
  const payload = parseToolText(search);
  const invoices = payload?.invoices ?? [];

  const rows = invoices.map((inv) => ({
    documentKind: "invoice",
    invoiceNumber: inv.InvoiceNumber ?? null,
    invoiceId: inv.InvoiceID ?? null,
    contact: inv.Contact?.Name ?? "No Contact",
    contactId: inv.Contact?.ContactID ?? null,
    type: inv.Type ?? null,
    status: inv.Status ?? null,
    date: inv.Date ?? null,
    total: inv.Total ?? null,
    amountDue: inv.AmountDue ?? null,
  }));

  console.log(JSON.stringify({ count: rows.length, transactions: rows }, null, 2));

  const targets = ["Intuate", "No Contact", "ELVEX PROPERTY SERVICES LTD"];
  for (const name of targets) {
    const matching = rows.filter((r) =>
      name === "No Contact"
        ? !r.contact || r.contact === "No Contact"
        : r.contact?.toUpperCase().includes(name.split(" ")[0].toUpperCase()),
    );
    console.log(
      JSON.stringify(
        {
          contactQuery: name,
          matches: matching.map((r) => ({
            invoiceNumber: r.invoiceNumber,
            type: r.type,
            status: r.status,
            total: r.total,
            contact: r.contact,
          })),
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
