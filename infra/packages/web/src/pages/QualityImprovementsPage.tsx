import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, Sparkles } from "lucide-react";
import { api } from "../api";
import {
  Button,
  DataCard,
  EmptyState,
  ErrorState,
  LoadingState,
  MobileRecordList,
  PageHeader,
  StatusBadge,
  formatDate,
  toast,
} from "../components";

type Overview = Awaited<ReturnType<typeof api.getQualityLoop>>;

export default function QualityImprovementsPage() {
  const [params] = useSearchParams();
  const reviewToken = params.get("review");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      if (reviewToken) {
        try {
          await api.resolveQualityLoopToken(reviewToken);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Review link invalid";
          if (/expired/i.test(message)) {
            toast("This review link has expired. Sign in and open Improvement Reviews from Quality.", "error");
          }
        }
      }
      setData(await api.getQualityLoop());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load quality loop");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [reviewToken]);

  const latest = data?.latest;
  const recommended = useMemo(
    () =>
      (latest?.proposals ?? []).filter(
        (row) => row.status === "pending_approval" && row.autoApplyable && row.risk !== "high" && !row.engineeringRequired,
      ),
    [latest],
  );

  async function approveRecommended() {
    if (!latest?.run.id) return;
    setBusy(true);
    try {
      await api.approveQualityLoopRecommended(latest.run.id);
      toast("Recommended improvements approved. Canary/validation will run before promotion.");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to approve", "error");
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "approve" | "reject" | "defer") {
    setBusy(true);
    try {
      await api.decideQualityLoopProposal(id, decision, latest?.run.id);
      toast(`Proposal ${decision}d`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to update proposal", "error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading improvement reviews…" />;
  if (error) return <ErrorState title="Unable to load improvement reviews" description={error} onRetry={() => void load()} />;

  const metrics = (latest?.run.metrics ?? {}) as Record<string, number>;
  const counts = data?.proposalCounts ?? {};

  return (
    <>
      <PageHeader
        title="Improvement Reviews"
        description="WhatsApp quality loop. Email links never apply changes — approval needs this signed-in admin session."
        breadcrumb={[
          { label: "Quality", to: "/quality" },
          { label: "Improvement Reviews" },
        ]}
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="button button-ghost button-small" to="/quality">
              Quality issues
            </Link>
            <Button type="button" variant="primary" disabled={busy || recommended.length === 0} onClick={() => void approveRecommended()}>
              Approve Recommended Improvements
            </Button>
          </div>
        }
      />

      <p className="muted small" style={{ marginTop: -8 }}>
        Cadence: {data?.cadence ?? "Daily 08:00 Europe/London, auto-changes to weekly after 60 days"}. Activated{" "}
        {data?.config.activatedAt ? formatDate(data.config.activatedAt) : "on first scheduler tick"}. Phase{" "}
        <strong>{data?.config.phase ?? "daily"}</strong>.
      </p>

      <div className="metric-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, margin: "16px 0" }}>
        <Kpi label="Conversations" value={String(metrics.conversationsAnalysed ?? data?.kpis.conversationsAnalysed ?? 0)} />
        <Kpi label="Quality" value={(metrics.qualityAverage ?? data?.kpis.qualityAverage ?? 0).toFixed(1)} />
        <Kpi label="Failed rate" value={`${Math.round((metrics.failedRate ?? data?.kpis.failedRate ?? 0) * 100)}%`} />
        <Kpi label="Rephrase" value={`${Math.round((metrics.rephraseRate ?? 0) * 100)}%`} />
        <Kpi label="Ack / final" value={`${Math.round(metrics.ackLatencyMs ?? 0)} / ${Math.round(metrics.finalLatencyMs ?? 0)}ms`} />
        <Kpi label="Open / approved" value={`${counts.pending_approval ?? 0} / ${counts.approved ?? 0}`} />
        <Kpi label="Deployed / rolled back" value={`${counts.promoted ?? counts.canary ?? 0} / ${counts.rolled_back ?? 0}`} />
      </div>

      {!latest ? (
        <EmptyState
          icon={<Sparkles size={28} />}
          title="No quality review yet"
          description="The loop runs daily at 08:00 Europe/London on the existing 15-minute scheduler. The first production tick also writes the Caddington baseline."
        />
      ) : (
        <>
          <h2 className="section-title">Failed conversations</h2>
          {latest.failedConversations.length === 0 ? (
            <EmptyState icon={<CheckCircle2 size={28} />} tone="good" title="No failed WhatsApp conversations in this period" />
          ) : (
            <MobileRecordList>
              {latest.failedConversations.map((row) => (
                <DataCard
                  key={row.id}
                  title={row.conversationKey}
                  subtitle={row.companyId}
                  status={<StatusBadge status={row.failed ? "high" : "healthy"} />}
                  metric={`Score ${row.overallScore}`}
                >
                  <p className="muted small">
                    {Array.isArray(row.flags)
                      ? row.flags
                          .filter((flag) => (flag as { polarity?: string }).polarity === "negative")
                          .map((flag) => (flag as { category: string }).category)
                          .join(", ")
                      : "See interaction detail"}
                  </p>
                  {row.interactionId ? (
                    <Link className="small" to={`/interactions?id=${encodeURIComponent(row.interactionId)}`}>
                      Open interaction
                    </Link>
                  ) : null}
                </DataCard>
              ))}
            </MobileRecordList>
          )}

          <h2 className="section-title">Patterns</h2>
          <MobileRecordList>
            {latest.patterns.map((pattern) => (
              <DataCard
                key={pattern.id}
                title={pattern.title}
                subtitle={pattern.companyId ?? "Platform aggregate (anonymised)"}
                status={<StatusBadge status={pattern.severity} />}
                metric={`${pattern.occurrenceCount}×`}
              >
                <p className="muted small">{pattern.rootCause}</p>
              </DataCard>
            ))}
          </MobileRecordList>

          <h2 className="section-title">Proposals</h2>
          <div className="desktop-table table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Risk</th>
                  <th>Tests</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {latest.proposals.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.title}</strong>
                      <div className="muted small">{row.summary}</div>
                      {row.engineeringRequired ? <div className="muted small">ENGINEERING CHANGE REQUIRED</div> : null}
                    </td>
                    <td>
                      <StatusBadge status={row.risk} />
                    </td>
                    <td className="muted small">
                      {row.pretest && typeof row.pretest === "object" && "accepted" in row.pretest
                        ? (row.pretest as { accepted?: boolean; reason?: string }).accepted
                          ? "Replay passed"
                          : (row.pretest as { reason?: string }).reason ?? "Rejected in replay"
                        : "—"}
                    </td>
                    <td>{row.status.replace(/_/g, " ")}</td>
                    <td>
                      {row.status === "pending_approval" ? (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <Button type="button" size="sm" disabled={busy} onClick={() => void decide(row.id, "approve")}>
                            Approve
                          </Button>
                          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void decide(row.id, "reject")}>
                            Reject
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void decide(row.id, "defer")}>
                            Defer
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="section-title">Improvement history</h2>
      <ul className="muted small">
        {(data?.history ?? []).slice(0, 20).map((row) => (
          <li key={row.id}>
            {formatDate(row.createdAt)} — {row.action.replace(/_/g, " ")}
            {row.actor ? ` · ${row.actor}` : ""}
            {row.runtimeVersion != null ? ` · v${row.runtimeVersion}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="data-card" style={{ padding: 12 }}>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 650 }}>{value}</div>
    </div>
  );
}
