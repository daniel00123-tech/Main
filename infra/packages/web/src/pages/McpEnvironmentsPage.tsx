import { Link } from "react-router-dom";
import { MOCK_MCP_ENVIRONMENTS } from "../mock-data";
import { PageHeader, StatusBadge, formatDate } from "../components";

export default function McpEnvironmentsPage() {
  return (
    <>
      <PageHeader
        title="MCP Environments"
        subtitle="Registered company MCP environments. Caddington MCP is external and monitored only."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Name</th>
              <th>Endpoint</th>
              <th>Health endpoint</th>
              <th>Version</th>
              <th>Status</th>
              <th>Enabled</th>
              <th>External</th>
              <th>Capabilities</th>
              <th>Last check</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_MCP_ENVIRONMENTS.map((mcp) => (
              <tr key={mcp.id}>
                <td>
                  <Link to={`/companies/${mcp.companySlug}`}>{mcp.company}</Link>
                </td>
                <td>{mcp.name}</td>
                <td className="mono">{mcp.endpoint}</td>
                <td className="mono">{mcp.healthEndpoint}</td>
                <td>{mcp.version}</td>
                <td>
                  <StatusBadge value={mcp.status} />
                </td>
                <td>{mcp.enabled ? "Yes" : "No"}</td>
                <td>{mcp.isExternal ? "Yes" : "No"}</td>
                <td>{mcp.capabilities.join(", ")}</td>
                <td>{formatDate(mcp.lastHealthCheck)}</td>
                <td>{mcp.latencyMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
