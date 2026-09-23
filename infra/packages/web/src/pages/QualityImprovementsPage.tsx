import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, CircleAlert, Sparkles } from "lucide-react";
import { api, type QualityLoopCentre, type QualityLoopProposal } from "../api";
import {
  Button,
  DataCard,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChip,
  KeyValue,
  LoadingState,
  MobileRecordList,
  PageHeader,
  StatusBadge,
  formatDate,
  toast,
} from "../components";
import {
  acceptRemainingButton,
  bulkLowButton,
  itemActionsEnabled,
  itemPrimaryHint,
  itemPrimaryKind,
  itemPrimaryLabel,
  pendingOpen,
} from "./quality-improvements-actions";

type FilterKey = "all" | "pending" | "low" | "engineering" | "applied";

export default function QualityImprovementsPage() {
  const [params, setParams] = useSearchParams();
  const reviewToken = params.get("review");
  const runParam = params.get("run");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<QualityLoopCentre | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("pending");
  const [selected, setSelected] = useState<QualityLoopProposal | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewQualityLoopProposal>> | null>(null);
  const [checked, setChecked] = useState<string[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      if (reviewToken) {
        try {
          const resolved = await api.resolveQualityLoopToken(reviewToken);
          if (resolved.runId && !runParam) {
            setParams((current) => {
              const next = new URLSearchParams(current);
              next.set("run", resolved.runId);
              return next;
            }, { replace: true });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Review link invalid";
          if (/expired/i.test(message)) {
            toast("This review link has expired. The latest persisted review is shown instead.", "error");
          }
        }
      }
      setData(await api.getQualityLoop(runParam ? { run: runParam } : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load quality improvements");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [reviewToken, runParam]);

  const latest = data?.latest;
  const proposals = latest?.proposals ?? [];
  const filtered = useMemo(() => {
    return proposals.filter((row) => {
      if (filter === "pending") return row.status === "pending_approval";
      if (filter === "low") return row.risk === "low" && row.applyClass === "AUTO_APPLY_SAFE";
      if (filter === "engineering") return row.applyClass === "REQUIRES_ENGINEERING" || row.engineeringRequired;
      if (filter === "applied") return ["canary", "promoted", "approved"].includes(row.status);
      return true;
    });
  }, [proposals, filter]);

  const lowBulk = bulkLowButton(proposals);
  const acceptBulk = acceptRemainingButton(proposals);
  const openItems = pendingOpen(proposals);

  async function applyLow() {
    if (!latest?.run.id || !lowBulk.enabled) return;
    setBusy(true);
    try {
      const result = await api.applyQualityLoopLow(latest.run.id);
      const applied = result.results.filter((row) => row.status === "canary" || row.status === "promoted").length;
      const reportOnly = result.results.length - applied;
      toast(
        applied
          ? `Applied ${applied} LOW-risk improvement${applied === 1 ? "" : "s"} to canary.`
          : reportOnly
            ? "No LOW-risk auto-apply items were executed."
            : "No LOW-risk proposals pending.",
      );
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to apply LOW-risk items", "error");
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "approve" | "reject" | "defer") {
    setBusy(true);
    try {
      const result = await api.decideQualityLoopProposal(id, decision, latest?.run.id);
      toast(
        decision === "approve"
          ? result.status === "canary" || result.status === "promoted"
            ? "Applied to quality runtime canary."
            : "Accepted. Review recorded — this item is not auto-deployed."
          : `Proposal ${decision}d`,
      );
      await load();
      if (selected?.id === id) setSelected(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to update proposal", "error");
    } finally {
      setBusy(false);
    }
  }

  async function acceptRemaining() {
    if (!latest?.run.id || !acceptBulk.enabled) return;
    setBusy(true);
    try {
      const ids = acceptRemainingButton(proposals).count
        ? proposals.filter((row) => itemPrimaryKind(row) === "accept").map((row) => row.id)
        : [];
      const result = await api.bulkQualityLoopDecide(latest.run.id, "approve", ids);
      const failed = result.results.filter((row) => !row.ok).length;
      toast(
        failed
          ? `Accepted ${result.results.length - failed} of ${result.results.length}. ${failed} failed.`
          : `Accepted ${result.results.length} open item${result.results.length === 1 ? "" : "s"}. Review recorded — not auto-deployed.`,
      );
      setChecked([]);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to accept remaining items", "error");
    } finally {
      setBusy(false);
    }
  }

  async function bulk(decision: "approve" | "reject") {
    if (!latest?.run.id || checked.length === 0) return;
    setBusy(true);
    try {
      const result = await api.bulkQualityLoopDecide(latest.run.id, decision, checked);
      const failed = result.results.filter((row) => !row.ok).length;
      toast(failed ? `Bulk ${decision}: ${result.results.length - failed} ok, ${failed} failed` : `Bulk ${decision} recorded`);
      setChecked([]);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Bulk update failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(row: QualityLoopProposal) {
    setSelected(row);
    setPreview(null);
    try {
      setPreview(await api.previewQualityLoopProposal(row.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to load preview", "error");
    }
  }

  async function rollback(id: string) {
    setBusy(true);
    try {
      const result = await api.rollbackQualityLoopProposal(id);
      toast(result.reason || "Rolled back");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to roll back", "error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading improvement control centre…" />;
  if (error) return <ErrorState title="Unable to load improvement reviews" description={error} onRetry={() => void load()} />;

  const metrics = (latest?.run.metrics ?? data?.kpis ?? {}) as Record<string, number>;
  const counts = data?.proposalCounts ?? {};
  const flags = asFlags;

  return (
    <>
      <PageHeader
        title="Improvement Reviews"
        description="WhatsApp quality loop. Email links never apply changes — approval needs this signed-in platform-admin session."
        breadcrumb={[
          { label: "Quality", to: "/quality" },
          { label: "Improvement Reviews" },
        ]}
        actions={
          <div className="quality-page-actions">
            <Link className="button button-ghost quality-tap-target" to="/quality">
              Quality issues
            </Link>
            {lowBulk.showButton ? (
              <Button
                type="button"
                variant="primary"
                className="quality-tap-target"
                disabled={busy || !lowBulk.enabled}
                onClick={() => void applyLow()}
              >
                Apply all LOW-risk{lowBulk.count ? ` (${lowBulk.count})` : ""}
              </Button>
            ) : (
              <p className="quality-bulk-reason" role="status">
                {lowBulk.reason}. Use Accept or Reject on the open items below.
              </p>
            )}
            {acceptBulk.showButton ? (
              <Button
                type="button"
                variant="primary"
                className="quality-tap-target"
                disabled={busy || !acceptBulk.enabled}
                title={acceptBulk.hint}
                onClick={() => void acceptRemaining()}
              >
                Accept remaining open ({acceptBulk.count})
              </Button>
            ) : null}
          </div>
        }
      />

      <p className="muted small" style={{ marginTop: -8 }}>
        Cadence: {data?.cadence ?? "Daily 08:00 Europe/London, auto-changes to weekly after 60 days"}. Activated{" "}
        {data?.config.activatedAt ? formatDate(data.config.activatedAt) : "on first scheduler tick"}. Phase{" "}
        <strong>{data?.config.phase ?? "daily"}</strong>.
        {latest?.run.id ? (
          <>
            {" "}
            Run <span className="mono">{latest.run.id}</span>
          </>
        ) : null}
      </p>

      <div className="metric-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, margin: "16px 0" }}>
        <Kpi label="Conversations" value={String(metrics.conversationsAnalysed ?? data?.kpis.conversationsAnalysed ?? 0)} />
        <Kpi label="Quality" value={Number(metrics.qualityAverage ?? data?.kpis.qualityAverage ?? 0).toFixed(1)} />
        <Kpi label="Failed rate" value={`${Math.round(Number(metrics.failedRate ?? data?.kpis.failedRate ?? 0) * 100)}%`} />
        <Kpi label="Open" value={String(counts.pending_approval ?? openItems.length)} />
        <Kpi label="Applied" value={String((counts.promoted ?? 0) + (counts.canary ?? 0))} />
        <Kpi label="Rolled back" value={String(counts.rolled_back ?? 0)} />
      </div>

      {!latest ? (
        <EmptyState
          icon={<Sparkles size={28} />}
          title="No quality review yet"
          description="The loop runs daily at 08:00 Europe/London. When a run exists, proposals and evidence appear here — this page never stays blank after a completed review."
        />
      ) : (
        <>
          {latest.ackNoFinalAudit ? (
            <div className="info-banner" style={{ marginBottom: 16 }}>
              <strong>ack_no_final:</strong> {latest.ackNoFinalAudit.classification}. {latest.ackNoFinalAudit.note}{" "}
              Watchdog: {latest.ackNoFinalAudit.terminalWatchdog}.
            </div>
          ) : null}

          <section className="quality-review-section" aria-labelledby="quality-proposals-heading">
            <h2 className="section-title" id="quality-proposals-heading">
              Proposed improvements
            </h2>
            <p className="muted small quality-review-hint">
              {openItems.length
                ? `${openItems.length} open item${openItems.length === 1 ? "" : "s"} need a review. Accept records the review and does not auto-deploy TIER B/C. Apply is only for pending LOW/MEDIUM AUTO_APPLY_SAFE items.`
                : "No open items. Applied canary items can still be rolled back."}
            </p>
            <FilterBar className="filter-bar-mobile-stack">
              <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={proposals.length}>
                All
              </FilterChip>
              <FilterChip active={filter === "pending"} onClick={() => setFilter("pending")} count={openItems.length}>
                Pending
              </FilterChip>
              <FilterChip active={filter === "low"} onClick={() => setFilter("low")} count={lowBulk.count}>
                LOW safe
              </FilterChip>
              <FilterChip active={filter === "engineering"} onClick={() => setFilter("engineering")}>
                Engineering
              </FilterChip>
              <FilterChip active={filter === "applied"} onClick={() => setFilter("applied")}>
                Applied
              </FilterChip>
            </FilterBar>
            {checked.length > 0 ? (
              <div className="quality-tap-actions" style={{ margin: "8px 0 12px" }}>
                <Button type="button" className="quality-tap-target" disabled={busy} onClick={() => void bulk("approve")}>
                  Apply selected ({checked.length})
                </Button>
                <Button type="button" className="quality-tap-target" variant="secondary" disabled={busy} onClick={() => void bulk("reject")}>
                  Reject selected
                </Button>
              </div>
            ) : null}

            {filtered.length === 0 ? (
              <EmptyState
                icon={<CircleAlert size={28} />}
                title="No proposals match this filter"
                description="Clear the filter to see every persisted improvement for this run."
                action={
                  <Button type="button" variant="secondary" className="quality-tap-target" onClick={() => setFilter("all")}>
                    Show all
                  </Button>
                }
              />
            ) : (
              <>
                <div className="mobile-cards">
                  <MobileRecordList>
                    {filtered.map((row) => (
                      <DataCard
                        key={row.id}
                        title={row.title}
                        subtitle={`${(row.applyClass ?? "").replace(/_/g, " ")} · ${(row.recurrence ?? "").toLowerCase()}`}
                        status={<StatusBadge status={row.risk} />}
                        metric={row.status.replace(/_/g, " ")}
                        actions={
                          <ProposalActions
                            row={row}
                            busy={busy}
                            checked={checked.includes(row.id)}
                            onCheck={(on) => setChecked((current) => (on ? [...current, row.id] : current.filter((id) => id !== row.id)))}
                            onOpen={() => void openDetail(row)}
                            onDecide={decide}
                            onRollback={rollback}
                          />
                        }
                      >
                        <p className="muted small">{row.summary}</p>
                      </DataCard>
                    ))}
                  </MobileRecordList>
                </div>
                <div className="desktop-table table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Proposal</th>
                        <th>Class</th>
                        <th>Risk</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={checked.includes(row.id)}
                              onChange={(event) =>
                                setChecked((current) =>
                                  event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                                )
                              }
                              aria-label={`Select ${row.title}`}
                            />
                          </td>
                          <td>
                            <strong>{row.title}</strong>
                            <div className="muted small">{row.summary}</div>
                          </td>
                          <td className="muted small">
                            {(row.applyClass ?? "—").replace(/_/g, " ")}
                            <div>{(row.recurrence ?? "").toLowerCase()}</div>
                          </td>
                          <td>
                            <StatusBadge status={row.risk} />
                          </td>
                          <td>{row.status.replace(/_/g, " ")}</td>
                          <td>
                            <ProposalActions
                              row={row}
                              busy={busy}
                              checked={checked.includes(row.id)}
                              hideCheck
                              onCheck={() => undefined}
                              onOpen={() => void openDetail(row)}
                              onDecide={decide}
                              onRollback={rollback}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <h2 className="section-title">Focused failures</h2>
          {latest.failedConversations.length === 0 ? (
            <EmptyState icon={<CheckCircle2 size={28} />} tone="good" title="No failed WhatsApp conversations in this period" />
          ) : (
            <MobileRecordList>
              {latest.failedConversations.map((row) => {
                const negative = flags(row.flags)
                  .filter((flag) => flag.polarity === "negative")
                  .map((flag) => flag.category)
                  .filter(Boolean)
                  .join(", ");
                return (
                  <DataCard
                    key={row.id}
                    title={companyLabel(row.companyId)}
                    subtitle={negative || row.conversationKey}
                    status={<StatusBadge status={row.failed ? "high" : "healthy"} />}
                    metric={`Score ${row.overallScore}`}
                  >
                    {(row.latencyBreakdown ?? []).length > 0 ? (
                      <p className="muted small">
                        Latency: {row.latencyBreakdown!.map((item) => `${item.stage} — ${item.evidence}`).join(" · ")}
                      </p>
                    ) : (
                      <p className="muted small">{negative || "See interaction detail"}</p>
                    )}
                    {row.interactionId ? (
                      <Link className="small" to={`/interactions?id=${encodeURIComponent(row.interactionId)}`}>
                        Open interaction
                      </Link>
                    ) : null}
                  </DataCard>
                );
              })}
            </MobileRecordList>
          )}

          <h2 className="section-title">Patterns</h2>
          {latest.patterns.length === 0 ? (
            <EmptyState icon={<CheckCircle2 size={28} />} tone="good" title="No repeating failure patterns" />
          ) : (
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
          )}
        </>
      )}

      <h2 className="section-title">Improvement history</h2>
      {(data?.history ?? []).length === 0 ? (
        <p className="muted small">No apply, reject, or canary events yet.</p>
      ) : (
        <ul className="muted small">
          {(data?.history ?? []).slice(0, 20).map((row) => (
            <li key={row.id}>
              {formatDate(row.createdAt)} — {row.action.replace(/_/g, " ")}
              {row.actor ? ` · ${row.actor}` : ""}
              {row.runtimeVersion != null ? ` · v${row.runtimeVersion}` : ""}
            </li>
          ))}
        </ul>
      )}

      <Drawer
        open={Boolean(selected)}
        onClose={() => {
          setSelected(null);
          setPreview(null);
        }}
        title={selected?.title ?? "Proposal"}
        footer={
          selected ? (
            <div className="quality-tap-actions">
              {itemPrimaryKind(selected) === "apply" || itemPrimaryKind(selected) === "accept" ? (
                <>
                  <Button
                    type="button"
                    className="quality-tap-target"
                    disabled={busy}
                    title={itemPrimaryHint(selected) ?? undefined}
                    onClick={() => void decide(selected.id, "approve")}
                  >
                    {itemPrimaryLabel(selected)}
                  </Button>
                  <Button type="button" variant="secondary" className="quality-tap-target" disabled={busy} onClick={() => void decide(selected.id, "reject")}>
                    Reject
                  </Button>
                </>
              ) : null}
              {itemPrimaryKind(selected) === "rollback" ? (
                <Button type="button" variant="secondary" className="quality-tap-target" disabled={busy} onClick={() => void rollback(selected.id)}>
                  Roll back
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {selected ? (
          <dl>
            <KeyValue label="Risk" value={selected.risk.toUpperCase()} />
            <KeyValue label="Class" value={(selected.applyClass ?? "—").replace(/_/g, " ")} />
            <KeyValue label="Tier" value={selected.applyTier ? `Tier ${selected.applyTier}` : "—"} />
            <KeyValue label="Recurrence" value={selected.recurrence ?? "—"} />
            <KeyValue label="Status" value={selected.status.replace(/_/g, " ")} />
            <KeyValue label="Summary" value={selected.summary} />
            {itemPrimaryHint(selected) ? <KeyValue label="Action" value={itemPrimaryHint(selected)} /> : null}
            {selected.customerProgressUnchanged ? (
              <KeyValue label="Customer progress" value="60s watchdog unchanged. Only quality warning thresholds can move." />
            ) : null}
            <KeyValue
              label="Evidence"
              value={<pre className="mono small" style={{ whiteSpace: "pre-wrap" }}>{formatEvidence(selected.evidence)}</pre>}
            />
            {preview ? (
              <>
                <KeyValue label="Preview applies?" value={preview.executesChanges ? "Yes" : "No — preview only"} />
                <KeyValue label="Validation" value={preview.validation.reason} />
                <KeyValue
                  label="Patch"
                  value={
                    <pre className="mono small" style={{ whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(preview.patches, null, 2)}
                    </pre>
                  }
                />
              </>
            ) : (
              <p className="muted small">Loading preview…</p>
            )}
          </dl>
        ) : null}
      </Drawer>
    </>
  );
}

function ProposalActions({
  row,
  busy,
  checked,
  hideCheck,
  onCheck,
  onOpen,
  onDecide,
  onRollback,
}: {
  row: QualityLoopProposal;
  busy: boolean;
  checked: boolean;
  hideCheck?: boolean;
  onCheck: (on: boolean) => void;
  onOpen: () => void;
  onDecide: (id: string, decision: "approve" | "reject" | "defer") => Promise<void>;
  onRollback: (id: string) => Promise<void>;
}) {
  const enabled = itemActionsEnabled(row, busy);
  const primary = itemPrimaryKind(row);
  return (
    <div className="quality-tap-actions">
      {hideCheck ? null : (
        <label className="small muted quality-select-label">
          <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} />
          Select
        </label>
      )}
      <Button type="button" variant="ghost" className="quality-tap-target" disabled={!enabled.evidence} onClick={onOpen}>
        Evidence
      </Button>
      {primary === "apply" || primary === "accept" ? (
        <>
          <Button
            type="button"
            className="quality-tap-target"
            disabled={!(primary === "apply" ? enabled.apply : enabled.accept)}
            title={itemPrimaryHint(row) ?? undefined}
            onClick={() => void onDecide(row.id, "approve")}
          >
            {itemPrimaryLabel(row)}
          </Button>
          <Button type="button" variant="secondary" className="quality-tap-target" disabled={!enabled.reject} onClick={() => void onDecide(row.id, "reject")}>
            Reject
          </Button>
        </>
      ) : null}
      {primary === "rollback" ? (
        <Button type="button" variant="secondary" className="quality-tap-target" disabled={!enabled.rollback} onClick={() => void onRollback(row.id)}>
          Roll back
        </Button>
      ) : null}
      {row.engineeringRequired || row.applyClass === "REQUIRES_ENGINEERING" || row.applyClass === "INFORMATIONAL" ? (
        <p className="muted small quality-item-hint">
          {row.status === "pending_approval"
            ? "Accept records review. Does not auto-deploy this change."
            : row.engineeringRequired
              ? "ENGINEERING CHANGE REQUIRED"
              : null}
        </p>
      ) : null}
    </div>
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

function companyLabel(companyId: string): string {
  if (companyId === "co_caddington") return "Caddington";
  if (companyId === "co_el") return "EL";
  if (companyId === "co_ht") return "HT";
  return companyId;
}

function asFlags(raw: unknown): Array<{ category?: string; evidence?: string; polarity?: string }> {
  return Array.isArray(raw) ? (raw as Array<{ category?: string; evidence?: string; polarity?: string }>) : [];
}

function formatEvidence(raw: unknown): string {
  try {
    return JSON.stringify(raw ?? {}, null, 2);
  } catch {
    return String(raw ?? "");
  }
}
