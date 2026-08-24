import { PageHeader, SectionCard, StatusBadge, formatCurrency, formatDate } from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { ErrorState, LoadingState } from "../components";

export default function PortalDashboardPage() {
  const { company, overview, loading, error, user } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !overview || !user) {
    return <ErrorState message={error ?? "Dashboard unavailable"} />;
  }

  const activeConnectors = overview.connectorInstances.filter(
    (connector) => connector.status !== "disabled" && connector.status !== "draft",
  ).length;
  const mcpStatus = overview.mcpEnvironments[0]?.status ?? "registered";

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.displayName.split(" ")[0]}`}
        subtitle={`${company.name} — your company AI infrastructure`}
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Credit balance</h3>
          <div className="metric">
            {formatCurrency(overview.creditBalance?.balanceCents ?? 0)}
          </div>
        </div>
        <div className="card metric-card">
          <h3>Connectors</h3>
          <div className="metric">
            {activeConnectors}/{overview.connectorInstances.length}
          </div>
        </div>
        <div className="card metric-card">
          <h3>MCP status</h3>
          <StatusBadge value={mcpStatus} />
        </div>
        <div className="card metric-card">
          <h3>Recent audit events</h3>
          <div className="metric">{overview.recentAuditEvents.length}</div>
        </div>
      </div>

      <div className="grid grid-2">
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
              {overview.connectorInstances.map((connector) => (
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

        <SectionCard title="Recent activity">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Actor</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {overview.recentAuditEvents.map((event) => (
                <tr key={event.id}>
                  <td>{event.eventType}</td>
                  <td>{event.actor}</td>
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
