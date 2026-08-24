import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { CompanyOverview } from "@infra/shared";
import { api } from "../api";
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
  const [error, setError] = useState<string | null>(null);
  const [healthMessage, setHealthMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .getCompanyOverview(slug)
      .then(setOverview)
      .catch((err: Error) => setError(err.message));
  }, [slug]);

  async function handleHealthCheck(mcpId: string) {
    try {
      const result = await api.runMcpHealthCheck(mcpId);
      setHealthMessage(`${result.status}: ${result.message}`);
      const refreshed = await api.getCompanyOverview(slug);
      setOverview(refreshed);
    } catch (err) {
      setHealthMessage(err instanceof Error ? err.message : "Health check failed");
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!overview) return <LoadingState />;

  const { company, mcpEnvironments, connectorInstances, creditBalance, recentAuditEvents } =
    overview;

  return (
    <>
      <PageHeader
        title={company.name}
        subtitle={company.notes ?? "Company control plane overview"}
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card">
          <h3>Status</h3>
          <StatusBadge value={company.status} />
        </div>
        <div className="card">
          <h3>MCP Environments</h3>
          <div className="metric">{mcpEnvironments.length}</div>
        </div>
        <div className="card">
          <h3>Connectors</h3>
          <div className="metric">{connectorInstances.length}</div>
        </div>
        <div className="card">
          <h3>Credit Balance</h3>
          <div className="metric">
            {creditBalance
              ? formatCurrency(creditBalance.balanceCents, creditBalance.currency)
              : "—"}
          </div>
        </div>
      </div>

      {healthMessage ? (
        <div className="card muted" style={{ marginBottom: 16 }}>
          Last health check: {healthMessage}
        </div>
      ) : null}

      <div className="stack">
        <SectionCard title="MCP Environments">
          {mcpEnvironments.length === 0 ? (
            <p className="muted">No MCP environments registered.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>External</th>
                  <th>Data Plane</th>
                  <th>Last Check</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mcpEnvironments.map((mcp) => (
                  <tr key={mcp.id}>
                    <td>
                      <div>{mcp.name}</div>
                      <div className="muted">{mcp.description}</div>
                    </td>
                    <td>{mcp.endpointUrl}</td>
                    <td>
                      <StatusBadge value={mcp.status} />
                    </td>
                    <td>{mcp.isExternal ? "Yes" : "No"}</td>
                    <td>{mcp.dataPlaneId ?? "—"}</td>
                    <td>{formatDate(mcp.lastHealthCheckAt)}</td>
                    <td>
                      <button
                        className="button"
                        type="button"
                        onClick={() => handleHealthCheck(mcp.id)}
                      >
                        Health check
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard title="Connector Instances">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Definition</th>
                <th>Status</th>
                <th>Health</th>
                <th>Last Sync</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {connectorInstances.map((connector) => (
                <tr key={connector.id}>
                  <td>{connector.name}</td>
                  <td>{connector.connectorDefinitionId}</td>
                  <td>
                    <StatusBadge value={connector.status} />
                  </td>
                  <td>
                    <StatusBadge value={connector.healthStatus} />
                  </td>
                  <td>{formatDate(connector.lastSyncAt)}</td>
                  <td className="muted">{connector.lastSyncMessage ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Recent Audit Events">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Actor</th>
                <th>Resource</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recentAuditEvents.map((event) => (
                <tr key={event.id}>
                  <td>{event.eventType}</td>
                  <td>{event.actor}</td>
                  <td>
                    {event.resourceType ?? "—"}
                    {event.resourceId ? ` / ${event.resourceId}` : ""}
                  </td>
                  <td>{formatDate(event.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>
    </>
  );
}
