import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Company } from "@infra/shared";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
} from "../components";

export default function DashboardPage() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.getSummary>> | null>(
    null,
  );
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [summaryData, companyList] = await Promise.all([
          api.getSummary(),
          api.getCompanies(),
        ]);
        setSummary(summaryData);
        setCompanies(companyList);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <LoadingState />;
  if (error || !summary) return <ErrorState message={error ?? "Dashboard unavailable"} />;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Operational overview across companies, connectors, MCP health, and audit activity."
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Companies</h3>
          <div className="metric">{summary.companies}</div>
        </div>
        <div className="card metric-card">
          <h3>Active Connectors</h3>
          <div className="metric">{summary.activeConnectors}</div>
        </div>
        <div className="card metric-card">
          <h3>MCP Health</h3>
          <div className="metric">
            {summary.healthyMcp}/{summary.mcpEnvironments}
          </div>
        </div>
        <div className="card metric-card">
          <h3>Connector Instances</h3>
          <div className="metric">{summary.connectorInstances}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Companies">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Domain</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.id}>
                  <td>
                    <Link to={`/companies/${company.slug}`}>{company.name}</Link>
                  </td>
                  <td>
                    <StatusBadge value={company.status} />
                  </td>
                  <td>{company.primaryDomain ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Recent audit events">
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
