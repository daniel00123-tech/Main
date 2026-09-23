/**
 * Local integration smoke test against wrangler dev (default http://127.0.0.1:8787).
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const baseUrl = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  const client = new Client({ name: "ht-business-mcp-test", version: "0.1.0" });

  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  const health = await client.callTool({ name: "system_health", arguments: {} });
  console.log("system_health:", JSON.stringify(health, null, 2));

  const summary = await client.callTool({
    name: "database_summary",
    arguments: {},
  });
  console.log("database_summary:", JSON.stringify(summary, null, 2));

  const query = await client.callTool({
    name: "query_business_data",
    arguments: {
      sql: "SELECT entity_type, description FROM entity_registry ORDER BY entity_type",
    },
  });
  console.log("query_business_data:", JSON.stringify(query, null, 2));

  const rejected = await client.callTool({
    name: "query_business_data",
    arguments: { sql: "DELETE FROM entity_records" },
  });
  console.log("query_rejected:", JSON.stringify(rejected, null, 2));

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
