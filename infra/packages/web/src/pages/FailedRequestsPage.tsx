import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  CollapsibleBlock,
  DataCard,
  EmptyState,
  ErrorState,
  LoadingState,
  MobileRecordList,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
} from "../components";
import { formatRelativeTime } from "../lib/format";

type WhatsAppIncident = {
  wamid?: string | null;
  companyId?: string | null;
  status?: string;
  stuck?: boolean;
  ageMs?: number;
  receivedAt?: string;
  lastError?: string | null;
  lifecycleState?: string;
};

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

function severityStatus(severity: FailureRow["severity"]) {
  if (severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "active";
}

function FailureCard({ row }: { row: FailureRow }) {
  return (
    <DataCard
      title={row.companyName ?? row.companySlug ?? "Unknown company"}
      subtitle={`${row.toolName ?? "Request"} · ${row.action ?? "unknown action"}`}
      status={
        <StatusBadge
          status={severityStatus(row.severity)}
          label={row.recurring ? `${row.severity} · recurring` : row.severity}
        />
      }
      metric={`${row.count} occurrence${row.count === 1 ? "" : "s"}`}
      timestamp={row.lastSeen ? `Last seen ${formatRelativeTime(row.lastSeen)}` : undefined}
    >
      <p className="muted small" style={{ margin: "8px 0 0" }}>
        {row.errorCode ?? "Unknown error"}
        {row.firstSeen ? ` · first ${formatRelativeTime(row.firstSeen)}` : ""}
      </p>
      {row.companySlug ? (
        <div className="mobile-record-actions">
          <Link to={`/companies/${row.companySlug}`} className="button button-secondary button-small">
            Investigate
          </Link>
        </div>
      ) : null}
    </DataCard>
  );
}

export default function FailedRequestsPage() {
  const [failures, setFailures] = useState<FailureRow[]>([]);
  const [whatsapp, setWhatsapp] = useState<{
    stuckCount: number;
    processingCount: number;
    failedCount: number;
    consecutiveFailedReplies: number;
    incidents: WhatsAppIncident[];
  } | null>(null);
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
      setWhatsapp(
        failed.whatsapp
          ? {
              stuckCount: Number(failed.whatsapp.stuckCount ?? 0),
              processingCount: Number(failed.whatsapp.processingCount ?? 0),
              failedCount: Number(failed.whatsapp.failedCount ?? 0),
              consecutiveFailedReplies: Number(failed.whatsapp.consecutiveFailedReplies ?? 0),
              incidents: (failed.whatsapp.incidents ?? []) as WhatsAppIncident[],
            }
          : null,
      );
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
  const oneOff = failures.filter((f) => !f.recurring);

  return (
    <>
      <PageHeader
        title="Failed requests"
        description="Last 7 days, grouped by company and error. Recurring patterns are shown first. WhatsApp messages with no user-visible reply after 30 seconds are treated as incidents."
      />

      {whatsapp && (whatsapp.stuckCount > 0 || whatsapp.failedCount > 0 || whatsapp.incidents.length > 0) ? (
        <SectionCard
          title="WhatsApp channel"
          description="Received, processing, stuck, failed and replied inbound messages. Stuck means received more than 30 seconds ago with no user-visible response."
        >
          <div className={`attention-banner ${whatsapp.stuckCount > 0 ? "warn" : ""}`}>
            <p className="attention-title">
              {whatsapp.stuckCount} stuck · {whatsapp.processingCount} processing · {whatsapp.failedCount} failed
            </p>
            <p className="muted small">
              {whatsapp.consecutiveFailedReplies >= 3
                ? "Three consecutive failed replies — treat as an operational incident."
                : "Open Quality for evidence-backed WhatsApp failures."}
            </p>
          </div>
          <div className="mobile-cards" style={{ marginTop: 12 }}>
            <MobileRecordList>
              {whatsapp.incidents.slice(0, 12).map((row, idx) => (
                <DataCard
                  key={`wa-${row.wamid ?? idx}`}
                  title={row.status === "stuck" ? "Stuck WhatsApp message" : "Failed WhatsApp reply"}
                  subtitle={row.wamid ?? "unknown wamid"}
                  status={<StatusBadge status={row.stuck ? "error" : "warning"} label={row.status ?? "failed"} />}
                  metric={row.ageMs != null ? `${Math.round(Number(row.ageMs) / 1000)}s` : "—"}
                >
                  <p className="muted small">
                    {row.lifecycleState ?? "received"}
                    {row.lastError ? ` · ${row.lastError}` : ""}
                    {row.receivedAt ? ` · ${formatRelativeTime(row.receivedAt)}` : ""}
                  </p>
                </DataCard>
              ))}
            </MobileRecordList>
          </div>
        </SectionCard>
      ) : null}

      {recurring.length > 0 ? (
        <SectionCard
          title="Recurring failures"
          description="The same error happened 3 or more times. Treat these as active incidents."
        >
          <div className="attention-banner warn">
            <p className="attention-title">{recurring.length} recurring pattern{recurring.length === 1 ? "" : "s"}</p>
            <p className="muted small">Investigate the company and latest error before dismissing as noise.</p>
          </div>
          <div className="mobile-cards" style={{ marginTop: 12 }}>
            <MobileRecordList>
              {recurring.map((row, idx) => (
                <FailureCard key={`rec-${row.companyId}-${row.toolName}-${row.errorCode}-${idx}`} row={row} />
              ))}
            </MobileRecordList>
          </div>
          <div className="desktop-table table-wrap" style={{ marginTop: 12 }}>
            <FailureTable rows={recurring} />
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title={recurring.length > 0 ? "One-off and historical" : "Failure groups"}
        description="Sorted by frequency. One-off failures are usually noise unless a company is already struggling."
      >
        {failures.length === 0 ? (
          <EmptyState
            tone="good"
            title="No failed requests in the last 7 days"
            description="This is healthy. New gateway or connector errors will appear here for review."
          />
        ) : oneOff.length === 0 ? (
          <p className="muted">No one-off failures — only the recurring patterns above.</p>
        ) : (
          <>
            <div className="mobile-cards">
              <MobileRecordList>
                {oneOff.map((row, idx) => (
                  <FailureCard key={`one-${row.companyId}-${row.toolName}-${row.errorCode}-${idx}`} row={row} />
                ))}
              </MobileRecordList>
            </div>
            <div className="desktop-table table-wrap">
              <FailureTable rows={oneOff} />
            </div>
          </>
        )}
      </SectionCard>

      {weekly.length > 0 ? (
        <SectionCard title="Weekly review summary" description="Top error patterns for operator review.">
          <div className="mobile-cards">
            <MobileRecordList>
              {weekly.map((row, idx) => (
                <DataCard
                  key={idx}
                  title={String(row.toolName ?? "Unknown tool")}
                  subtitle={String(row.errorCode ?? "unknown")}
                  status={<StatusBadge status={String(row.severity ?? "low") === "high" ? "error" : "warning"} />}
                  metric={`${Number(row.count ?? 0)} times`}
                />
              ))}
            </MobileRecordList>
          </div>
          <div className="desktop-table table-wrap">
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

function FailureTable({ rows }: { rows: FailureRow[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Company</th>
          <th>Feature</th>
          <th>Error</th>
          <th>Count</th>
          <th>First seen</th>
          <th>Last seen</th>
          <th>Severity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr key={`${row.companyId}-${row.toolName}-${row.errorCode}-${idx}`}>
            <td>
              {row.companySlug ? (
                <Link to={`/companies/${row.companySlug}`}>{row.companyName ?? row.companySlug}</Link>
              ) : (
                row.companyName ?? "Unknown company"
              )}
            </td>
            <td>
              <div>{row.toolName ?? "—"}</div>
              <div className="muted small">{row.action ?? "—"}</div>
            </td>
            <td>
              <CollapsibleBlock title={row.errorCode ?? "unknown"} summary="Technical">
                <p className="mono small">{row.errorCode ?? "unknown"}</p>
              </CollapsibleBlock>
            </td>
            <td>{row.count}</td>
            <td className="muted small">{row.firstSeen ? formatRelativeTime(row.firstSeen) : "—"}</td>
            <td className="muted small">{row.lastSeen ? formatDate(row.lastSeen) : "—"}</td>
            <td>
              <StatusBadge status={severityStatus(row.severity)} />
              {row.recurring ? <span className="muted small"> recurring</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
