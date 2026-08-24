import { PageHeader, SectionCard, StatusBadge, formatCurrency, formatDate } from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { ErrorState, LoadingState } from "../components";

function connectionLabel(mcpStatus: string | undefined): string {
  if (mcpStatus === "healthy") return "Connected · Healthy";
  if (mcpStatus === "degraded") return "Connected · Degraded";
  if (mcpStatus === "unreachable") return "Unavailable";
  if (mcpStatus === "registered") return "Registered · awaiting check";
  return mcpStatus ?? "Unknown";
}

export default function PortalDashboardPage() {
  const { company, overview, loading, error, user } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !overview || !user) {
    return <ErrorState message={error ?? "Dashboard unavailable"} />;
  }

  const mcp = overview.mcpEnvironments[0];
  const usage = overview.usageSummary;
  const wallet = overview.wallet;
  const activeConnectors = overview.connectorInstances.filter(
    (item) => item.status !== "disabled" && item.status !== "draft",
  ).length;
  const knowledgeAvailable =
    mcp?.status === "healthy" &&
    (mcp.knowledgeDocumentCount == null || mcp.knowledgeDocumentCount > 0);

  return (
    <>
      <PageHeader
        title={company.name}
        subtitle="Company portal — connections, usage, credit, and recent activity"
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Available credit</h3>
          <div className="metric">
            {wallet
              ? formatCurrency(wallet.balanceCents, wallet.currency)
              : "Not configured"}
          </div>
          {wallet?.lowBalance ? (
            <p className="warning-text">Low balance</p>
          ) : null}
        </div>
        <div className="card metric-card">
          <h3>Requests this month</h3>
          <div className="metric">{usage?.requestsThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Requests today</h3>
          <div className="metric">{usage?.requestsToday ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>MCP status</h3>
          <StatusBadge value={mcp?.status ?? "registered"} />
          <p className="muted small">{connectionLabel(mcp?.status)}</p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Successful</h3>
          <div className="metric">{usage?.successfulThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Failed</h3>
          <div className="metric">{usage?.failedThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Connected systems</h3>
          <div className="metric">{activeConnectors}</div>
        </div>
        <div className="card metric-card">
          <h3>Knowledge</h3>
          <div className="metric">
            {knowledgeAvailable
              ? mcp?.knowledgeDocumentCount != null
                ? String(mcp.knowledgeDocumentCount)
                : "Available"
              : "—"}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Connections">
          <table className="table compact">
            <tbody>
              <tr>
                <td>Company MCP</td>
                <td>
                  <StatusBadge value={mcp?.status ?? "registered"} />{" "}
                  {connectionLabel(mcp?.status)}
                </td>
              </tr>
              <tr>
                <td>Documents available</td>
                <td>
                  {mcp?.knowledgeDocumentCount != null
                    ? mcp.knowledgeDocumentCount
                    : "Not confirmed"}
                </td>
              </tr>
              <tr>
                <td>Last successful request</td>
                <td>{formatDate(mcp?.lastSuccessfulRequestAt)}</td>
              </tr>
              <tr>
                <td>AI clients via INFRA</td>
                <td>See AI Connections</td>
              </tr>
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Recent activity">
          {overview.recentAuditEvents.length === 0 ? (
            <p className="muted">No recent activity for this company.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Who</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {overview.recentAuditEvents.map((event) => (
                  <tr key={event.id}>
                    <td>{event.eventType.replace(/\./g, " · ")}</td>
                    <td>{event.actor}</td>
                    <td>{formatDate(event.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
      </div>
    </>
  );
}
