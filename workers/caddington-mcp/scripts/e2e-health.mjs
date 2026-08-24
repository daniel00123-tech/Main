import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.MCP_URL ?? "https://caddington-mcp.daniel-dwyer123.workers.dev/mcp";

const client = new Client({ name: "caddington-e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const health = await client.callTool({ name: "system_health", arguments: {} });
console.log("system_health:", health.content?.[0]?.text);

const search = await client.callTool({
  name: "search_company_knowledge",
  arguments: { query: "boiler maintenance", topK: 3 },
});
console.log("search_company_knowledge:", search.content?.[0]?.text);

await client.close();
