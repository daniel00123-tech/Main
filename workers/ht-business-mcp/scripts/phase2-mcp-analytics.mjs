/**
 * Phase 2 analytics validation through HT Business MCP (query_business_data only).
 * Usage: MCP_URL=https://... MCP_AUTH_TOKEN=... node scripts/phase2-mcp-analytics.mjs
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const baseUrl = process.env.MCP_URL ?? "https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp";
const mcpToken = process.env.MCP_AUTH_TOKEN;

if (!mcpToken) {
  console.error("MCP_AUTH_TOKEN is required");
  process.exit(1);
}

const transportOptions = {
  requestInit: {
    headers: { Authorization: `Bearer ${mcpToken}` },
  },
};

async function query(client, sql) {
  const result = await client.callTool({
    name: "query_business_data",
    arguments: { sql },
  });
  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

async function main() {
  const transport = new StreamableHTTPClientTransport(
    new URL(baseUrl),
    transportOptions
  );
  const client = new Client({ name: "phase2-analytics", version: "0.2.1" });
  await client.connect(transport);

  const health = await client.callTool({ name: "system_health", arguments: {} });
  console.log("=== system_health ===");
  console.log(health.content?.[0]?.text);

  const summary = await client.callTool({
    name: "database_summary",
    arguments: {},
  });
  console.log("=== database_summary ===");
  console.log(summary.content?.[0]?.text);

  const analytics = {};

  analytics.totalRevenue = await query(
    client,
    "SELECT ROUND(SUM(customer_charge), 2) AS total_revenue FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy'"
  );

  analytics.totalGrossProfit = await query(
    client,
    "SELECT ROUND(SUM(gross_profit), 2) AS total_gross_profit FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy'"
  );

  analytics.averageGrossMargin = await query(
    client,
    "SELECT ROUND(AVG(gross_margin_pct), 2) AS average_gross_margin_pct FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy'"
  );

  analytics.completedJobs = await query(
    client,
    "SELECT COUNT(*) AS completed_jobs FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy'"
  );

  analytics.topCustomersByRevenue = await query(
    client,
    "SELECT c.name, ROUND(SUM(j.customer_charge), 2) AS revenue FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.status_code = 'completed' AND j.source_system = 'phase2_dummy' GROUP BY c.id, c.name ORDER BY revenue DESC LIMIT 5"
  );

  analytics.topEngineersByCompletedJobs = await query(
    client,
    "SELECT e.name, COUNT(*) AS completed_jobs FROM jobs j JOIN engineers e ON j.engineer_id = e.id WHERE j.status_code = 'completed' AND j.source_system = 'phase2_dummy' GROUP BY e.id, e.name ORDER BY completed_jobs DESC LIMIT 5"
  );

  analytics.quoteConversion = await query(
    client,
    "SELECT COUNT(*) AS total_quotes, SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) AS converted_quotes, ROUND(100.0 * SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) AS conversion_rate_pct FROM quotes WHERE source_system = 'phase2_dummy'"
  );

  analytics.averageCompletedJobValue = await query(
    client,
    "SELECT ROUND(AVG(customer_charge), 2) AS average_completed_job_value FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy'"
  );

  analytics.lowMarginJobs = await query(
    client,
    "SELECT COUNT(*) AS jobs_below_30_pct_margin FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy' AND gross_margin_pct < 30"
  );

  analytics.revenueByMonth = await query(
    client,
    "SELECT substr(completion_date, 1, 7) AS month, ROUND(SUM(customer_charge), 2) AS revenue FROM jobs WHERE status_code = 'completed' AND source_system = 'phase2_dummy' AND completion_date IS NOT NULL GROUP BY substr(completion_date, 1, 7) ORDER BY month"
  );

  console.log("=== analytics (via query_business_data) ===");
  console.log(JSON.stringify(analytics, null, 2));

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
