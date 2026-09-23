#!/usr/bin/env node
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "gdrive-inspect", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(
    new URL("https://caddington-mcp.daniel-dwyer123.workers.dev/mcp")
  )
);

for (const sql of [
  "SELECT id, source_system, import_type, status, records_processed, records_failed, error_message, metadata, started_at FROM import_log WHERE source_system = 'google_drive' ORDER BY started_at DESC LIMIT 3",
  "SELECT drive_file_id, name, mime_type, sync_status, skip_reason FROM google_drive_files ORDER BY last_synced_at DESC LIMIT 20",
  "SELECT id, external_id, title, status, mime_type FROM knowledge_documents WHERE external_id LIKE 'gdrive-%' ORDER BY id DESC LIMIT 10",
]) {
  const result = await client.callTool({
    name: "query_business_data",
    arguments: { sql, limit: 20 },
  });
  console.log("\nSQL:", sql);
  console.log(result.content?.[0]?.text);
}

await client.close();
