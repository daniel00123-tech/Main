import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PlatformSummary } from "../api";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  formatDate,
} from "../components";

export default function DashboardPage() {
  const [summary, setSummary] = useState<PlatformSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSummary()
      .then(setSummary)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!summary) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="Control Plane Dashboard"
        subtitle="Administration and monitoring for company AI infrastructure. Staff-facing AI clients remain external."
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card">
          <h3>Companies</h3>
          <div className="metric">{summary.companies}</div>
        </div>
        <div className="card">
          <h3>MCP Environments</h3>
          <div className="metric">{summary.mcpEnvironments}</div>
        </div>
        <div className="card">
          <h3>Healthy MCP</h3>
          <div className="metric">{summary.healthyMcp}</div>
        </div>
        <div className="card">
          <h3>Connector Instances</h3>
          <div className="metric">{summary.connectorInstances}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Architecture">
          <p className="muted">
            INFRA is the control plane. Business systems remain systems of record.
            Customer knowledge and operational data stay isolated per company.
          </p>
          <p className="muted">
            Company cloud systems → connector → sync/index → company MCP → ChatGPT / Claude / future channels.
          </p>
          <p>
            <Link to="/companies">View companies</Link> ·{" "}
            <Link to="/connectors">View connector catalogue</Link>
          </p>
        </SectionCard>

        <SectionCard title="Recent Audit Events">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Actor</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {summary.recentAuditEvents.map((event) => (
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
