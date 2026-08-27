import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
} from "../components";
import { formatRelativeTime } from "../lib/format";

type FailureRow = {
  companyId: string;
  companyName: string | null;
  companySlug: string | null;
  toolName: string | null;
  action: string | null;
  errorCode: string | null;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  severity: "high" | "medium" | "low";
  recurring: boolean;
};

export default function FailedRequestsPage() {
  const [failures, setFailures] = useState<FailureRow[]>([]);
  const [weekly, setWeekly] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [failed, review] = await Promise.all([
        api.getFailedRequests(),
        api.getWeeklyReview().catch(() => ({ summary: [] })),
      ]);
      setFailures(failed.failures as FailureRow[]);
      setWeekly(review.summary ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load failed requests");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingState label="Loading failed requests…" />;
  if (error) {
    return (
      <ErrorState title="Unable to load failed requests" description={error} onRetry={() => void load()} />
    );
  }

  const recurring = failures.filter((f) => f.recurring);

  return (
    <>
      <PageHeader
        title="Failed requests"
        description="Last 7 days — grouped by company, integration, and error. Human review required before any automated production fix."
      />

      {recurring.length > 0 ? (
        <SectionCard
          title="Recurring failures"
          description="Same error occurred 3+ times — prioritise for weekly review."
        >
          <div className="attention-banner warn">
            <p className="attention-title">{recurring.length} recurring pattern(s)</p>
            <p className="muted small">
              Use Usage export and audit log for full detail. This view does not modify production.
            </p>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Failure groups" description="Sorted by frequency (highest first).">
        {failures.length === 0 ? (
          <EmptyState title="No failed requests" description="No gateway failures in the last 7 days." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Tool / action</th>
                  <th>Error</th>
                  <th>Count</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((row, idx) => (
                  <tr key={`${row.companyId}-${row.toolName}-${row.errorCode}-${idx}`}>
                    <td>
                      {row.companySlug ? (
                        <Link to={`/companies/${row.companySlug}`}>{row.companyName ?? row.companySlug}</Link>
                      ) : (
                        row.companyName ?? row.companyId
                      )}
                    </td>
                    <td>
                      <div>{row.toolName ?? "—"}</div>
                      <div className="muted small">{row.action ?? "—"}</div>
                    </td>
                    <td className="mono small">{row.errorCode ?? "unknown"}</td>
                    <td>{row.count}</td>
                    <td className="muted small">
                      {row.firstSeen ? formatRelativeTime(row.firstSeen) : "—"}
                    </td>
                    <td className="muted small">
                      {row.lastSeen ? formatDate(row.lastSeen) : "—"}
                    </td>
                    <td>
                      <StatusBadge
                        status={
                          row.severity === "high"
                            ? "error"
                            : row.severity === "medium"
                              ? "warning"
                              : "active"
                        }
                      />
                      {row.recurring ? (
                        <span className="muted small" style={{ marginLeft: 6 }}>
                          recurring
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {weekly.length > 0 ? (
        <SectionCard title="Weekly review summary" description="Top error patterns for operator review.">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Error</th>
                  <th>Tool</th>
                  <th>Count</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {weekly.map((row, idx) => (
                  <tr key={idx}>
                    <td className="mono small">{String(row.errorCode ?? "unknown")}</td>
                    <td>{String(row.toolName ?? "—")}</td>
                    <td>{Number(row.count ?? 0)}</td>
                    <td>{String(row.severity ?? "low")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}
    </>
  );
}
