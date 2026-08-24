import { PageHeader, SectionCard, StatusBadge, formatDate } from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { ErrorState, LoadingState } from "../components";

function humanStatus(value: string): string {
  switch (value) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "unreachable":
      return "Unavailable";
    case "registered":
      return "Registered";
    case "configured":
      return "Configured";
    case "syncing":
      return "Syncing";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
    case "draft":
      return "Not set up";
    default:
      return value.replace(/_/g, " ");
  }
}

function connectionLabel(mcpStatus: string | undefined): string {
  if (mcpStatus === "healthy") return "Connected · Healthy";
  if (mcpStatus === "degraded") return "Connected · Degraded";
  if (mcpStatus === "unreachable") return "Unavailable";
  if (mcpStatus === "registered") return "Registered · awaiting check";
  return humanStatus(mcpStatus ?? "unknown");
}

export default function PortalDashboardPage() {
  const { company, overview, loading, error, user } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !overview || !user) {
    return <ErrorState message={error ?? "Dashboard unavailable"} />;
  }

  const mcp = overview.mcpEnvironments[0];
  const drive = overview.connectorInstances.find((item) =>
    item.name.toLowerCase().includes("google drive"),
  );
  const usage = overview.usageSummary;
  const knowledgeAvailable =
    mcp?.status === "healthy" &&
    (mcp.knowledgeDocumentCount == null || mcp.knowledgeDocumentCount > 0);

  const driveConnected =
    drive &&
    drive.status !== "draft" &&
    drive.status !== "disabled" &&
    (drive.healthStatus === "healthy" ||
      drive.status === "healthy" ||
      drive.status === "configured" ||
      (mcp?.knowledgeDocumentCount != null && mcp.knowledgeDocumentCount > 0));

  return (
    <>
      <PageHeader
        title={company.name}
        subtitle="Company portal — connections, usage, and recent activity"
      />

      <div className="grid grid-2" style={{ marginBottom: 24 }}>
        <SectionCard title="Connections">
          <table className="table compact">
            <tbody>
              <tr>
                <td>Caddington MCP</td>
                <td>
                  <StatusBadge value={mcp?.status ?? "registered"} />{" "}
                  {connectionLabel(mcp?.status)}
                </td>
              </tr>
              <tr>
                <td>Google Drive / Workspace</td>
                <td>
                  {driveConnected ? (
                    <>
                      <StatusBadge value="healthy" /> Connected
                    </>
                  ) : (
                    <>
                      <StatusBadge value={drive?.status ?? "draft"} />{" "}
                      {drive ? humanStatus(drive.status) : "Not configured"}
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td>Knowledge</td>
                <td>
                  {knowledgeAvailable ? (
                    <>
                      Available
                      {mcp?.knowledgeDocumentCount != null
                        ? ` · ${mcp.knowledgeDocumentCount} documents`
                        : ""}
                    </>
                  ) : mcp?.status === "healthy" ? (
                    "Connected · no documents reported yet"
                  ) : (
                    "Not confirmed"
                  )}
                </td>
              </tr>
              <tr>
                <td>Last successful sync</td>
                <td>
                  {formatDate(
                    mcp?.lastSyncAt ?? drive?.lastSyncAt ?? mcp?.lastSuccessfulRequestAt,
                  )}
                </td>
              </tr>
              <tr>
                <td>Last health check</td>
                <td>{formatDate(mcp?.lastHealthCheckAt)}</td>
              </tr>
            </tbody>
          </table>
          {mcp?.healthMessage ? (
            <p className="muted small" style={{ marginTop: 12 }}>
              {mcp.healthMessage}
            </p>
          ) : null}
        </SectionCard>

        <SectionCard title="AI Connections">
          <table className="table compact">
            <tbody>
              <tr>
                <td>ChatGPT</td>
                <td>
                  <StatusBadge value="registered" /> Not connected via INFRA
                </td>
              </tr>
              <tr>
                <td>Claude</td>
                <td>
                  <StatusBadge value="registered" /> Not connected via INFRA
                </td>
              </tr>
              <tr>
                <td>WhatsApp</td>
                <td>
                  <StatusBadge value="draft" /> Coming soon
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small" style={{ marginTop: 12 }}>
            AI clients will connect through the INFRA gateway in a later phase. Existing
            direct ChatGPT → Caddington MCP traffic is unchanged.
          </p>
        </SectionCard>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Requests today</h3>
          <div className="metric">{usage?.requestsToday ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Requests this month</h3>
          <div className="metric">{usage?.requestsThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Successful</h3>
          <div className="metric">{usage?.successfulThisMonth ?? 0}</div>
        </div>
        <div className="card metric-card">
          <h3>Failed</h3>
          <div className="metric">{usage?.failedThisMonth ?? 0}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Usage">
          <p className="muted">
            Live request metering for {company.name}. Cost and billing are not configured
            yet — usage is recorded for measurement only.
          </p>
          <p className="muted small">
            Cost this month: not configured
          </p>
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
