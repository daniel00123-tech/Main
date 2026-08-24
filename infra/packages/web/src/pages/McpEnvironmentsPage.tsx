import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Company, McpEnvironment } from "@infra/shared";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
  formatDate,
} from "../components";

interface McpRow extends McpEnvironment {
  companyName?: string;
  companySlug?: string;
}

export default function McpEnvironmentsPage() {
  const [rows, setRows] = useState<McpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [mcpList, companies] = await Promise.all([
          api.getMcpEnvironments(),
          api.getCompanies(),
        ]);
        const companyById = new Map(companies.map((company: Company) => [company.id, company]));
        setRows(
          mcpList.map((mcp) => {
            const company = companyById.get(mcp.companyId);
            return {
              ...mcp,
              companyName: company?.name,
              companySlug: company?.slug,
            };
          }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load MCP environments");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function runHealthCheck(id: string) {
    setCheckingId(id);
    try {
      await api.runMcpHealthCheck(id);
      const refreshed = await api.getMcpEnvironments();
      setRows((current) =>
        current.map((row) => refreshed.find((item) => item.id === row.id) ?? row),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Health check failed");
    } finally {
      setCheckingId(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error && rows.length === 0) return <ErrorState message={error} />;

  return (
    <>
      <PageHeader
        title="MCP Environments"
        subtitle="Registered company MCP environments. Health checks require authenticated access."
      />
      {error ? <div className="error-box">{error}</div> : null}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Name</th>
              <th>Endpoint</th>
              <th>Version</th>
              <th>Status</th>
              <th>Enabled</th>
              <th>Capabilities</th>
              <th>Last check</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((mcp) => (
              <tr key={mcp.id}>
                <td>
                  {mcp.companySlug ? (
                    <Link to={`/companies/${mcp.companySlug}`}>{mcp.companyName}</Link>
                  ) : (
                    mcp.companyName
                  )}
                </td>
                <td>{mcp.name}</td>
                <td className="mono">{mcp.endpointUrl}</td>
                <td>{mcp.mcpVersion ?? "—"}</td>
                <td>
                  <StatusBadge value={mcp.status} />
                </td>
                <td>{mcp.enabled ? "Yes" : "No"}</td>
                <td>{mcp.capabilities.join(", ") || "—"}</td>
                <td>{formatDate(mcp.lastHealthCheckAt)}</td>
                <td>
                  <button
                    className="button button-small"
                    type="button"
                    disabled={checkingId === mcp.id}
                    onClick={() => void runHealthCheck(mcp.id)}
                  >
                    {checkingId === mcp.id ? "Checking..." : "Health check"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
