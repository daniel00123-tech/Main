import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  DataCard,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  MobileRecordList,
  PageHeader,
  Select,
  StatusBadge,
  formatDate,
  toast,
} from "../components";

const STATUSES = ["new", "investigating", "accepted", "fixed", "dismissed"];
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

export default function QualityIssuesPage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.getQualityIssues>>["items"]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getQualityIssues({
        companyId: scopeCompanyId || undefined,
        status: status || undefined,
      });
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load quality issues");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [scopeCompanyId, status]);

  async function setIssueStatus(id: string, next: string) {
    try {
      await api.setQualityIssueStatus(id, next);
      toast(`Issue marked ${next}`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to update issue", "error");
    }
  }

  if (loading) return <LoadingState label="Loading quality issues…" />;
  if (error) return <ErrorState title="Unable to load quality issues" description={error} onRetry={() => void load()} />;

  const sorted = [...items].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  return (
    <>
      <PageHeader
        title="Quality"
        description="Evidence-backed issues from conversations. Improvement Reviews can auto-apply LOW/MEDIUM WhatsApp config only after you approve."
        actions={
          <Link className="button button-secondary button-small" to="/quality/improvements">
            Improvement Reviews
          </Link>
        }
      />
      <FilterBar className="filter-bar-mobile-stack">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </FilterBar>
      {sorted.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={28} />}
          tone="good"
          title="No quality issues detected in this period"
          description="Infra reviews a sample of interactions after they complete. An empty queue means no evidence-backed failures, retries, or permission errors were grouped for review."
        />
      ) : (
        <>
          <div className="mobile-cards">
            <MobileRecordList>
              {sorted.map((row) => (
                <DataCard
                  key={row.id}
                  title={row.category.replace(/_/g, " ")}
                  subtitle={[row.companyName, row.userEmail].filter(Boolean).join(" · ")}
                  status={<StatusBadge status={row.severity} />}
                  metric={`Seen ${row.occurrenceCount}×`}
                  timestamp={`Last ${formatDate(row.lastSeenAt)}`}
                >
                  <p className="muted small">{row.suggestedInvestigation}</p>
                  <Select
                    value={row.status}
                    aria-label={`Status for ${row.category}`}
                    onChange={(e) => void setIssueStatus(row.id, e.target.value)}
                  >
                    {STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </DataCard>
              ))}
            </MobileRecordList>
          </div>
          <div className="table-wrap desktop-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Company</th>
                  <th>User</th>
                  <th>Count</th>
                  <th>Last seen</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.category.replace(/_/g, " ")}</strong>
                      <div className="muted small">
                        {row.severity} · {row.suggestedInvestigation}
                      </div>
                    </td>
                    <td>{row.companyName ?? "—"}</td>
                    <td>{row.userEmail ?? row.userName ?? "—"}</td>
                    <td>{row.occurrenceCount}</td>
                    <td className="muted small">{formatDate(row.lastSeenAt)}</td>
                    <td>
                      <Select
                        value={row.status}
                        aria-label={`Status for ${row.category}`}
                        onChange={(e) => void setIssueStatus(row.id, e.target.value)}
                      >
                        {STATUSES.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
