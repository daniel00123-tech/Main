import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { CompanyOverview } from "@infra/shared";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";

export default function CompanyDetailPage() {
  const { slug = "" } = useParams();
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.getCompanyOverview(slug);
        setOverview(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load company");
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  if (loading) return <LoadingState />;
  if (error || !overview) return <ErrorState message={error ?? "Company not found"} />;

  const { company, mcpEnvironments, connectorInstances, creditBalance, usageSummary, wallet } =
    overview;
  const activeConnectors = connectorInstances.filter(
    (connector) => connector.status !== "disabled" && connector.status !== "draft",
  ).length;
  const balanceCents = wallet?.balanceCents ?? creditBalance?.balanceCents ?? 0;
  const currency = wallet?.currency ?? creditBalance?.currency ?? "GBP";

  return (
    <>
      <PageHeader
        title={company.name}
        subtitle={`Status: ${company.status} · Domain: ${company.primaryDomain ?? "—"}`}
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Status</h3>
          <StatusBadge value={company.status} />
        </div>
        <div className="card metric-card">
          <h3>MCP environments</h3>
          <div className="metric">{mcpEnvironments.length}</div>
        </div>
        <div className="card metric-card">
          <h3>Connectors</h3>
          <div className="metric">
            {activeConnectors}/{connectorInstances.length}
          </div>
        </div>
        <div className="card metric-card">
          <h3>Wallet balance</h3>
          <div className="metric">{formatCurrency(balanceCents, currency)}</div>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Requests this month</h3>
          <div className="metric">{usageSummary?.requestsThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Successful</h3>
          <div className="metric">{usageSummary?.successfulThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Failed</h3>
          <div className="metric">{usageSummary?.failedThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Portal</h3>
          <Link to="/portal/dashboard">Open company portal</Link>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="MCP environments">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Enabled</th>
                <th>Last check</th>
              </tr>
            </thead>
            <tbody>
              {mcpEnvironments.map((mcp) => (
                <tr key={mcp.id}>
                  <td>{mcp.name}</td>
                  <td>
                    <StatusBadge value={mcp.status} />
                  </td>
                  <td>{mcp.enabled ? "Yes" : "No"}</td>
                  <td>{formatDate(mcp.lastHealthCheckAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Connectors">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {connectorInstances.map((connector) => (
                <tr key={connector.id}>
                  <td>{connector.name}</td>
                  <td>
                    <StatusBadge value={connector.status} />
                  </td>
                  <td>
                    <StatusBadge value={connector.healthStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      {company.notes ? (
        <div className="card" style={{ marginTop: 24 }}>
          <p className="muted">{company.notes}</p>
        </div>
      ) : null}
    </>
  );
}
