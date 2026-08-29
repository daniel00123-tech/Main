import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CircleAlert } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  Select,
  StatusBadge,
  formatDate,
  toast,
} from "../components";

const STATUSES = ["new", "investigating", "accepted", "fixed", "dismissed"];

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

  return (
    <>
      <PageHeader
        title="Quality / Issues"
        description="Evidence-backed post-run signals. This queue never changes production code, prompts, or integrations."
      />
      <FilterBar>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </FilterBar>
      {items.length === 0 ? (
        <EmptyState
          icon={<CircleAlert size={28} />}
          title="No quality issues"
          description="Failed tools, timeouts, permission errors, and retries will group here."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Company</th>
                <th>User</th>
                <th>Count</th>
                <th>First / last</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.category}</strong>
                    <div className="muted small">
                      {row.severity} · {Math.round(row.confidence * 100)}% · {row.suggestedInvestigation}
                    </div>
                    {row.interactionId ? (
                      <Link to="/interactions" className="table-link small">
                        {row.interactionId}
                      </Link>
                    ) : null}
                  </td>
                  <td>{row.companyName ?? "—"}</td>
                  <td>{row.userEmail ?? row.userName ?? "—"}</td>
                  <td>{row.occurrenceCount}</td>
                  <td className="muted small">
                    {formatDate(row.firstSeenAt)}
                    <br />
                    {formatDate(row.lastSeenAt)}
                  </td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td>
                    <Select
                      value={row.status}
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
      )}
    </>
  );
}
