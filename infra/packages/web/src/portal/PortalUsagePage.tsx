import { useEffect, useState } from "react";
import { PageHeader, SectionCard, StatusBadge, formatDate } from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { ErrorState, LoadingState } from "../components";
import { api, type CompanyUsageResponse } from "../api";

export default function PortalUsagePage() {
  const { company, loading: companyLoading, error: companyError } = usePortalCompany();
  const [usage, setUsage] = useState<CompanyUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        const data = await api.getCompanyUsage(company.slug, 50);
        setUsage(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load usage");
      } finally {
        setLoading(false);
      }
    })();
  }, [company]);

  if (companyLoading || loading) return <LoadingState />;
  if (companyError || error || !company || !usage) {
    return <ErrorState message={companyError ?? error ?? "Usage unavailable"} />;
  }

  const { summary, records } = usage;

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Live request metering for your company. Billing and wallet charges are not configured yet."
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Requests today</h3>
          <div className="metric">{summary.requestsToday}</div>
        </div>
        <div className="card metric-card">
          <h3>Requests this month</h3>
          <div className="metric">{summary.requestsThisMonth}</div>
        </div>
        <div className="card metric-card">
          <h3>Successful</h3>
          <div className="metric">{summary.successfulThisMonth}</div>
        </div>
        <div className="card metric-card">
          <h3>Failed</h3>
          <div className="metric">{summary.failedThisMonth}</div>
        </div>
      </div>

      <SectionCard title="Usage records">
        {records.length === 0 ? (
          <div className="empty-state">
            <p>No usage recorded yet for {company.name}.</p>
            <p className="muted">
              When INFRA routes a request to your MCP, it appears here with tool, result,
              latency, and correlation ID.
            </p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Who</th>
                <th>Result</th>
                <th>Duration</th>
                <th>Cost</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>{record.toolName ?? record.action ?? record.resourceType}</td>
                  <td>{record.actorEmail ?? "—"}</td>
                  <td>
                    <StatusBadge value={record.success === false ? "error" : "healthy"} />
                    {record.success === false ? " Failed" : " OK"}
                  </td>
                  <td>
                    {record.durationMs != null ? `${record.durationMs} ms` : "—"}
                  </td>
                  <td className="muted">Not configured</td>
                  <td>{formatDate(record.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </>
  );
}
