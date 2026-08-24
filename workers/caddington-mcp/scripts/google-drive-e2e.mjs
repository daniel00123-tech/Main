#!/usr/bin/env node
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE =
  process.env.CADDINGTON_BASE_URL ??
  "https://caddington-mcp.daniel-dwyer123.workers.dev";
const ADMIN_TOKEN = process.env.CADDINGTON_ADMIN_TOKEN;
const MCP_URL = process.env.MCP_URL ?? `${BASE}/mcp`;

if (!ADMIN_TOKEN) {
  console.error("CADDINGTON_ADMIN_TOKEN is required.");
  process.exit(1);
}

async function admin(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

printSection("1. Connector status");
const status = await admin("/admin/connectors/google_drive");
console.log(JSON.stringify(status.body, null, 2));

printSection("2. Dry-run sync");
const dryRun = await admin("/admin/connectors/google_drive/sync", {
  method: "POST",
  body: JSON.stringify({ dryRun: true, autoIndex: false }),
});
console.log(JSON.stringify(dryRun.body, null, 2));

const runReal = process.argv.includes("--real-sync");
if (!runReal) {
  console.log("\nDry run only. Re-run with --real-sync to import and index.");
  process.exit(dryRun.status === 200 && dryRun.body.ok ? 0 : 1);
}

printSection("3. Real sync (autoIndex: true)");
const realSync = await admin("/admin/connectors/google_drive/sync", {
  method: "POST",
  body: JSON.stringify({ dryRun: false, autoIndex: true }),
});
console.log(JSON.stringify(realSync.body, null, 2));

printSection("4. MCP search");
const client = new Client({ name: "gdrive-e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

const imported = realSync.body?.imported ?? 0;
const updated = realSync.body?.updated ?? 0;
const searchQuery =
  process.env.SEARCH_QUERY ??
  (imported + updated > 0 ? "Caddington Knowledge Google Drive" : "Project Falcon");

const search = await client.callTool({
  name: "search_company_knowledge",
  arguments: { query: searchQuery, topK: 5, includeDiagnostics: true },
});
console.log("search query:", searchQuery);
console.log(search.content?.[0]?.text ?? search);

await client.close();
process.exit(realSync.status === 200 && realSync.body.ok ? 0 : 1);
