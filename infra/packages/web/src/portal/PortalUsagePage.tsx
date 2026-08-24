import { useEffect, useState } from "react";
import { ChartColumn } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  MetricGrid,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { api, type CompanyUsageResponse } from "../api";
import { humanClient, humanOperation } from "../lib/format";

export default function PortalUsagePage() {
  const { company, loading: companyLoading, error: companyError } = usePortalCompany();
  const [usage, setUsage] = useState<CompanyUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        setUsage(await api.getCompanyUsage(company.slug, 50));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load usage");
      } finally {
        setLoading(false);
      }
    })();
  }, [company]);

  if (companyLoading || loading) return <LoadingState />;
  if (companyError || error || !company || !usage) {
    return (
      <ErrorState
        title="Unable to load usage"
        description={companyError ?? error ?? undefined}
      />
    );
  }

  const { summary, records } = usage;

  return (
    <>
      <PageHeader
        title="Usage"
        description="What happened when someone used AI with your company. Each row is one operation."
      />

      <MetricGrid cols={4}>
        <MetricCard label="Requests today" value={summary.requestsToday} />
        <MetricCard label="This month" value={summary.requestsThisMonth} />
        <MetricCard label="Successful" value={summary.successfulThisMonth} />
        <MetricCard label="Failed" value={summary.failedThisMonth} />
      </MetricGrid>

      <SectionCard title="Recent requests" description="Newest first.">
        {records.length === 0 ? (
          <EmptyState
            icon={<ChartColumn size={28} />}
            title="No usage recorded yet"
            description="Usage will appear after the first request passes through INFRA."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>AI client</th>
                  <th>User</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th className="num">Charge</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>{formatDate(record.recordedAt)}</td>
                    <td>{humanClient(record.sourceClient)}</td>
                    <td>{record.actorEmail ?? "—"}</td>
                    <td>
                      {humanOperation(record.action, record.toolName)}
                      {record.interactionId ? (
                        <div className="muted small">Grouped with other steps in this request</div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge status={record.success === false ? "failed" : "completed"} />
                    </td>
                    <td className="num">
                      {record.customerChargeCents != null
                        ? formatCurrency(record.customerChargeCents)
                        : "—"}
                    </td>
                    <td>
                      {record.durationMs != null ? `${record.durationMs} ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
