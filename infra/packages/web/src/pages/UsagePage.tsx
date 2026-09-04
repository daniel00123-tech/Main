import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChartColumn, Download } from "lucide-react";
import { classifyUsageOutcome, type Company, type UsageInteraction, type UsageRecord } from "@infra/shared";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  KeyValue,
  LoadingState,
  MetricCard,
  MetricGrid,
  PageHeader,
  SearchInput,
  Select,
  ShowMoreFooter,
  StatusBadge,
  formatCurrency,
  formatDate,
  toast,
} from "../components";
import {
  classifyUsageFailure,
  formatNumber,
  formatRelativeTime,
  humanActor,
  humanClient,
  humanFailureCategory,
  humanOperation,
  integrationLabel,
  type UsageFailureCategory,
} from "../lib/format";

type UsageRow = UsageRecord & {
  companyName: string;
  companySlug: string;
};

export default function UsagePage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [summary, setSummary] = useState<{
    requests: number;
    successful: number;
    failed: number;
    denied?: number;
    operationalFailed?: number;
    noResults?: number;
    customerChargesCents: number;
    underlyingCostsCents: number | null;
    providerCostKnown?: boolean;
    providerCostUnavailableReason?: string | null;
    grossProfitCents: number | null;
    grossMarginBps: number | null;
    rawSuccessRate?: number | null;
    operationalSuccessRate?: number | null;
    customerMeaningfulSuccessRate?: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [sourceClient, setSourceClient] = useState("");
  const [successFilter, setSuccessFilter] = useState("");
  const [failureCategory, setFailureCategory] = useState("");
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<UsageRow | null>(null);
  const [view, setView] = useState<"interactions" | "operations">("interactions");
  const [interactions, setInteractions] = useState<UsageInteraction[]>([]);
  const [openInteraction, setOpenInteraction] = useState<string | null>(null);
  const [displayLimit, setDisplayLimit] = useState(15);
  const [auditEvents, setAuditEvents] = useState<
    Awaited<ReturnType<typeof api.getAuditEvents>>
  >([]);

  useEffect(() => {
    setCompanyId(scopeCompanyId ?? "");
  }, [scopeCompanyId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const companyList = await api.getCompanies();
      setCompanies(companyList);
      const usage = await api.getCommercialUsage({
        companyId: companyId || undefined,
        sourceClient: sourceClient || undefined,
        success:
          successFilter === "success"
            ? true
            : successFilter === "failed"
              ? false
              : undefined,
      });
      const companyById = new Map(companyList.map((c) => [c.id, c]));
      const mapped: UsageRow[] = usage.records.map((record) => {
        const company = companyById.get(record.companyId);
        return {
          ...record,
          companyName: company?.name ?? record.companyId,
          companySlug: company?.slug ?? "",
        };
      });
      setRows(mapped);
      setInteractions(usage.interactions ?? []);
      setSummary(usage.summary);
    } catch (err) {
      // Fallback to per-company usage if commercial route unavailable
      try {
        const companyList = companies.length ? companies : await api.getCompanies();
        setCompanies(companyList);
        const collected: UsageRow[] = [];
        await Promise.all(
          companyList.map(async (company) => {
            try {
              const usage = await api.getCompanyUsage(company.slug, 50);
              for (const record of usage.records) {
                collected.push({
                  ...record,
                  companyName: company.name,
                  companySlug: company.slug,
                });
              }
            } catch {
              /* skip */
            }
          }),
        );
        collected.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
        setRows(collected);
        setInteractions([]);
        setSummary(null);
      } catch (fallbackErr) {
        setError(
          err instanceof Error
            ? err.message
            : fallbackErr instanceof Error
              ? fallbackErr.message
              : "Unable to load usage",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, sourceClient, successFilter]);

  useEffect(() => {
    setDisplayLimit(15);
  }, [query, companyId, sourceClient, successFilter, failureCategory, view]);

  useEffect(() => {
    if (!selected) {
      setAuditEvents([]);
      return;
    }
    void (async () => {
      try {
        const events = await api.getAuditEvents({ companyId: selected.companyId, limit: 80 });
        const corr = selected.correlationId;
        const req = selected.requestId;
        const usageId = selected.id;
        const ledgerId = selected.ledgerEntryId;
        setAuditEvents(
          events.filter((event) => {
            const detail = event.detail ?? {};
            const detailText = JSON.stringify(detail);
            return (
              (corr && detailText.includes(corr)) ||
              (req && detailText.includes(req)) ||
              (usageId && (event.resourceId === usageId || detailText.includes(usageId))) ||
              (ledgerId && (event.resourceId === ledgerId || detailText.includes(ledgerId)))
            );
          }),
        );
      } catch {
        setAuditEvents([]);
      }
    })();
  }, [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows;
    if (successFilter === "denied") {
      list = list.filter((r) => classifyUsageFailure(r) === "PERMISSION");
    }
    if (successFilter === "operational") {
      list = list.filter(
        (r) => r.success === false && classifyUsageFailure(r) !== "PERMISSION",
      );
    }
    if (successFilter === "no_results") {
      list = list.filter((r) => r.metadata?.accessOutcome === "empty_result");
    }
    if (failureCategory) {
      list = list.filter(
        (r) => classifyUsageFailure(r) === failureCategory,
      );
    }
    if (!q) return list;
    return list.filter(
      (r) =>
        r.companyName.toLowerCase().includes(q) ||
        (r.action ?? "").toLowerCase().includes(q) ||
        (r.toolName ?? "").toLowerCase().includes(q) ||
        (r.sourceClient ?? "").toLowerCase().includes(q) ||
        (r.requestId ?? "").toLowerCase().includes(q) ||
        humanActor(r.actorEmail ?? r.userId).toLowerCase().includes(q),
    );
  }, [rows, query, failureCategory, successFilter]);

  const totals = useMemo(() => {
    const requestsFromRows = filtered.length;
    const successfulFromRows = filtered.filter((r) => r.success !== false).length;
    const failedFromRows = filtered.filter((r) => r.success === false).length;
    const deniedFromRows = filtered.filter((r) => classifyUsageFailure(r) === "PERMISSION").length;
    const operationalFromRows = failedFromRows - deniedFromRows;
    const noResultsFromRows = filtered.filter((r) => r.metadata?.accessOutcome === "empty_result").length;
    const customerChargesCents = filtered.reduce(
      (sum, r) => sum + (r.customerChargeCents ?? 0),
      0,
    );
    const knownCosts = filtered.filter(
      (r) => r.costBasis === "actual" && r.underlyingCostCents != null,
    );
    const underlyingCostsCents = knownCosts.length
      ? knownCosts.reduce((sum, r) => sum + (r.underlyingCostCents ?? 0), 0)
      : 0;
    const costsKnown = knownCosts.length > 0;
    const grossProfitCents = costsKnown
      ? filtered.reduce((sum, r) => {
          if (r.costBasis !== "actual" || r.underlyingCostCents == null) return sum;
          return sum + (r.customerChargeCents ?? 0) - r.underlyingCostCents;
        }, 0)
      : 0;
    const useSummary = Boolean(summary && !query.trim() && !successFilter && !failureCategory);
    const requests = useSummary ? summary!.requests : requestsFromRows;
    const successful = useSummary ? summary!.successful : successfulFromRows;
    const failed = useSummary ? summary!.failed : failedFromRows;
    const denied = useSummary ? summary!.denied ?? deniedFromRows : deniedFromRows;
    const operationalFailed = useSummary
      ? summary!.operationalFailed ?? operationalFromRows
      : operationalFromRows;
    const noResults = useSummary ? summary!.noResults ?? noResultsFromRows : noResultsFromRows;
    const operationalDenom = requests - denied;
    return {
      requests,
      successful,
      failed,
      denied,
      operationalFailed,
      noResults,
      customerChargesCents: useSummary ? summary!.customerChargesCents : customerChargesCents,
      underlyingCostsCents: useSummary ? summary!.underlyingCostsCents : underlyingCostsCents,
      providerCostKnown: useSummary ? Boolean(summary!.providerCostKnown) : costsKnown,
      providerCostUnavailableReason: useSummary ? summary!.providerCostUnavailableReason : null,
      grossProfitCents: useSummary ? summary!.grossProfitCents : grossProfitCents,
      grossMarginBps: useSummary
        ? summary!.grossMarginBps
        : customerChargesCents > 0
          ? Math.round((grossProfitCents * 10_000) / customerChargesCents)
          : null,
      rawSuccessRate: useSummary
        ? summary!.rawSuccessRate ?? (requests > 0 ? successful / requests : null)
        : requests > 0
          ? successful / requests
          : null,
      operationalSuccessRate: useSummary
        ? summary!.operationalSuccessRate ??
          (operationalDenom > 0 ? (operationalDenom - operationalFailed) / operationalDenom : null)
        : operationalDenom > 0
          ? (operationalDenom - operationalFailed) / operationalDenom
          : null,
      customerMeaningfulSuccessRate: useSummary
        ? summary!.customerMeaningfulSuccessRate ??
          (operationalDenom > 0 ? successful / operationalDenom : null)
        : operationalDenom > 0
          ? successful / operationalDenom
          : null,
    };
  }, [filtered, summary, query, successFilter, failureCategory]);

  const successRate =
    totals.operationalSuccessRate != null
      ? Math.round(totals.operationalSuccessRate * 100)
      : null;
  const rawSuccessRate =
    totals.rawSuccessRate != null ? Math.round(totals.rawSuccessRate * 100) : null;
  const highFailureRate =
    (totals.operationalFailed ?? 0) > 0 &&
    totals.requests > 0 &&
    (totals.operationalFailed ?? 0) / Math.max(1, totals.requests - (totals.denied ?? 0)) > 0.25;

  async function exportCsv() {
    setExporting(true);
    try {
      const blob = await api.exportCommercialUsage({
        companyId: companyId || undefined,
        sourceClient: sourceClient || undefined,
        success:
          successFilter === "success"
            ? true
            : successFilter === "failed"
              ? false
              : undefined,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `infra-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast("Usage exported to CSV");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Export failed", "error");
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <LoadingState label="Loading usage…" />;
  if (error) {
    return <ErrorState title="Unable to load usage" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Usage"
        description="Customer charges, operational success, expected permission denials, and provider cost. Denials are not outages."
        actions={
          <Button type="button" variant="secondary" size="sm" loading={exporting} onClick={() => void exportCsv()}>
            <Download size={14} /> Export CSV
          </Button>
        }
      />

      <MetricGrid cols={3}>
        <MetricCard
          label="Customer charges"
          value={
            totals.customerChargesCents > 0
              ? formatCurrency(totals.customerChargesCents)
              : "—"
          }
        />
        <MetricCard
          label="Operational success"
          value={successRate != null ? `${successRate}%` : "—"}
          hint={`${formatNumber(totals.successful)} executed ok · ${formatNumber(totals.operationalFailed ?? 0)} operational failures. Expected denials are excluded.`}
        />
        <MetricCard
          label="Expected denials"
          value={formatNumber(totals.denied ?? 0)}
          hint="RBAC / permission blocks. Audited and not billed — not outages."
        />
      </MetricGrid>

      <div style={{ marginTop: 12 }}>
        <MetricGrid cols={3}>
        <MetricCard
          label="Underlying provider cost"
          value={
            totals.providerCostKnown && totals.underlyingCostsCents != null
              ? formatCurrency(totals.underlyingCostsCents)
              : "Unavailable"
          }
          hint={
            totals.providerCostKnown
              ? undefined
              : totals.providerCostUnavailableReason ??
                "Shown when provider rate cards have measurable unit costs. Missing cost is not treated as £0."
          }
        />
        <MetricCard
          label="Gross profit"
          value={
            totals.providerCostKnown && totals.grossProfitCents != null
              ? formatCurrency(totals.grossProfitCents)
              : "Unavailable"
          }
        />
        <MetricCard
          label="Gross margin"
          value={
            totals.grossMarginBps != null
              ? `${(totals.grossMarginBps / 100).toFixed(1)}%`
              : "—"
          }
        />
        <MetricCard
          label="Raw success (incl. denials as failed)"
          value={rawSuccessRate != null ? `${rawSuccessRate}%` : "—"}
          hint={`${formatNumber(totals.failed)} raw failed rows · ${formatNumber(totals.noResults ?? 0)} valid no-results`}
        />
        <MetricCard
          label="Operational failures"
          value={formatNumber(totals.operationalFailed ?? 0)}
          hint={highFailureRate ? "High operational failure share — review categories" : "Timeouts, upstream, and application errors"}
        />
        <MetricCard label="Successful requests" value={formatNumber(totals.successful)} />
        </MetricGrid>
      </div>

      <FilterBar className="filter-bar-mobile-stack">
        <SearchInput value={query} onChange={setQuery} placeholder="Search usage…" className="grow" />
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={sourceClient} onChange={(e) => setSourceClient(e.target.value)}>
          <option value="">All AI clients</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="claude">Claude</option>
          <option value="infra-admin-test">Admin test</option>
        </Select>
        <Select value={successFilter} onChange={(e) => setSuccessFilter(e.target.value)}>
          <option value="">Success & failure</option>
          <option value="success">Successful</option>
          <option value="failed">All failed (incl. denials)</option>
          <option value="denied">Expected denials</option>
          <option value="operational">Operational failures</option>
          <option value="no_results">Valid no-results</option>
        </Select>
        <Select value={failureCategory} onChange={(e) => setFailureCategory(e.target.value)}>
          <option value="">All failure types</option>
          {(
            [
              "AUTHENTICATION",
              "PERMISSION",
              "MISSING_CAPABILITY",
              "VALIDATION",
              "UPSTREAM_API",
              "RATE_LIMIT",
              "TIMEOUT",
              "INSUFFICIENT_CREDIT",
              "INFRA_INTERNAL",
              "USER_INPUT",
              "UNKNOWN",
            ] as UsageFailureCategory[]
          ).map((cat) => (
            <option key={cat} value={cat}>
              {humanFailureCategory(cat)}
            </option>
          ))}
        </Select>
        <Select
          value={view}
          onChange={(e) => setView(e.target.value as "interactions" | "operations")}
        >
          <option value="interactions">Interactions</option>
          <option value="operations">Operations</option>
        </Select>
      </FilterBar>

      {view === "interactions" && interactions.length > 0 ? (
        <div className="interaction-list">
          {interactions.slice(0, displayLimit).map((item) => {
            const open = openInteraction === item.id;
            return (
              <article key={item.id} className="interaction-card">
                <button
                  type="button"
                  className="interaction-summary"
                  onClick={() => setOpenInteraction(open ? null : item.id)}
                >
                  <div>
                    <div className="interaction-when">{formatDate(item.createdAt)}</div>
                    <div className="muted small">{humanClient(item.clientKind)}</div>
                  </div>
                  <div className="interaction-main">
                    <strong>{item.label}</strong>
                    <div className="muted small">
                      {item.operationCount === 1
                        ? "1 operation"
                        : `${item.operationCount} operations`}
                    </div>
                  </div>
                  <div className="interaction-meta">
                    <StatusBadge status={item.status === "error" ? "failed" : "completed"} />
                    <div className="num interaction-charge">
                      {formatCurrency(item.customerChargeCents)}
                    </div>
                  </div>
                </button>
                {open ? (
                  <div className="interaction-body">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Operation</th>
                          <th className="num">Charge</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.operations.map((op) => (
                          <tr
                            key={op.id}
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              const company = companies.find((c) => c.id === op.companyId);
                              setSelected({
                                ...op,
                                companyName: company?.name ?? op.companyId,
                                companySlug: company?.slug ?? "",
                              });
                            }}
                          >
                            <td>{humanOperation(op.action, op.toolName)}</td>
                            <td className="num">
                              {op.customerChargeCents != null
                                ? formatCurrency(op.customerChargeCents)
                                : "—"}
                            </td>
                            <td>
                              <StatusBadge
                                status={op.success === false ? "failed" : "completed"}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {view === "interactions" && interactions.length > 0 ? (
        <ShowMoreFooter
          shown={Math.min(displayLimit, interactions.length)}
          total={interactions.length}
          onShowMore={() => setDisplayLimit((n) => n + 15)}
        />
      ) : null}

      {view === "interactions" && interactions.length === 0 ? (
        <EmptyState
          icon={<ChartColumn size={28} />}
          title="No interactions yet"
          description="Grouped interactions appear when usage is recorded through the gateway."
        />
      ) : null}

      {view === "operations" && filtered.length === 0 ? (
        <EmptyState
          icon={<ChartColumn size={28} />}
          title="No usage recorded yet"
          description="Usage appears after a request passes through the INFRA gateway or MCP facade."
        />
      ) : view === "operations" ? (
        <>
        <div className="table-wrap desktop-only">
          <table className="table compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Company</th>
                <th>Actor</th>
                <th>AI client</th>
                <th>Action</th>
                <th>System</th>
                <th className="num">Charge</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, displayLimit).map((row) => {
                const failure = classifyUsageFailure(row);
                return (
                  <tr
                    key={row.id}
                    style={{ cursor: "pointer" }}
                    tabIndex={0}
                    onClick={() => setSelected(row)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(row);
                      }
                    }}
                  >
                    <td>{formatRelativeTime(row.recordedAt)}</td>
                    <td>
                      {row.companySlug ? (
                        <Link
                          to={`/companies/${row.companySlug}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.companyName}
                        </Link>
                      ) : (
                        row.companyName
                      )}
                    </td>
                    <td className="muted">{humanActor(row.actorEmail ?? row.userId)}</td>
                    <td className="muted">{humanClient(row.sourceClient)}</td>
                    <td>{humanOperation(row.action, row.toolName)}</td>
                    <td className="muted">{integrationLabel(row.action, row.toolName)}</td>
                    <td className="num">
                      {row.customerChargeCents != null
                        ? formatCurrency(row.customerChargeCents)
                        : "—"}
                    </td>
                    <td>
                      <StatusBadge status={row.success !== false ? "completed" : "failed"} />
                      {failure ? (
                        <div className="muted small">{humanFailureCategory(failure)}</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ShowMoreFooter
          shown={Math.min(displayLimit, filtered.length)}
          total={filtered.length}
          onShowMore={() => setDisplayLimit((n) => n + 20)}
        />
        </>
      ) : null}

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Usage details">
        {selected ? <UsageDetail row={selected} auditEvents={auditEvents} /> : null}
      </Drawer>
    </>
  );
}

function UsageDetail({
  row,
  auditEvents,
}: {
  row: UsageRow;
  auditEvents: Awaited<ReturnType<typeof api.getAuditEvents>>;
}) {
  const balanceBefore =
    typeof row.metadata?.balanceBeforeCents === "number"
      ? row.metadata.balanceBeforeCents
      : null;
  const balanceAfter =
    balanceBefore != null && row.customerChargeCents != null
      ? balanceBefore - row.customerChargeCents
      : null;

  const costLabel = formatUnderlyingCost(row);

  return (
    <>
      <h3 className="section-title" style={{ marginTop: 0 }}>
        Request
      </h3>
      <KeyValue label="Client" value={humanClient(row.sourceClient)} />
      <KeyValue label="Actor" value={humanActor(row.actorEmail ?? row.userId)} />
      <KeyValue label="Company" value={row.companyName} />
      <KeyValue
        label="Integration"
        value={integrationLabel(row.action, row.toolName)}
      />
      <KeyValue
        label="Operation"
        value={humanOperation(row.action, row.toolName)}
      />
      <KeyValue
        label="Outcome"
        value={(() => {
          const outcome = classifyUsageOutcome(row);
          if (outcome.expectedDenial) return "Expected denial";
          if (outcome.noResults) return "Valid no-results";
          if (outcome.kind === "SUCCESS") return "Success";
          if (outcome.historicalHint === "xero_tool_mapping") {
            return "Historical — Xero tool mapping (current regression passes)";
          }
          if (outcome.historicalHint === "knowledge_timeout") {
            return "Historical — knowledge timeout cluster";
          }
          if (outcome.historicalHint === "isolation_probe") return "Historical — isolation probe";
          return outcome.kind.replace(/_/g, " ").toLowerCase();
        })()}
      />
      <KeyValue
        label="Failure category"
        value={
          classifyUsageFailure(row)
            ? humanFailureCategory(classifyUsageFailure(row)!)
            : "—"
        }
      />
      <KeyValue
        label="Status"
        value={
          <StatusBadge
            status={
              classifyUsageOutcome(row).expectedDenial
                ? "denied"
                : row.success !== false
                  ? "completed"
                  : "failed"
            }
          />
        }
      />
      <KeyValue label="Recorded" value={formatRelativeTime(row.recordedAt)} />
      <KeyValue
        label="Customer charge"
        value={
          row.customerChargeCents != null ? formatCurrency(row.customerChargeCents) : "Not priced"
        }
      />
      <KeyValue
        label="Latency"
        value={row.durationMs != null ? `${row.durationMs} ms` : "—"}
      />
      {row.interactionId ? (
        <KeyValue label="Interaction" value={row.interactionId} mono />
      ) : null}

      <h3 className="section-title">Commercial</h3>
      <KeyValue label="Underlying cost" value={costLabel} />
      <KeyValue
        label="Customer charge"
        value={
          row.customerChargeCents != null ? formatCurrency(row.customerChargeCents) : "Not priced"
        }
      />
      <KeyValue
        label="Gross profit"
        value={
          row.grossProfitCents != null
            ? formatCurrency(row.grossProfitCents)
            : row.customerChargeCents != null && row.underlyingCostCents != null
              ? formatCurrency(row.customerChargeCents - row.underlyingCostCents)
              : "—"
        }
      />
      <KeyValue
        label="Gross margin"
        value={
          row.actualMarginBps != null
            ? `${(row.actualMarginBps / 100).toFixed(1)}%`
            : "—"
        }
      />
      <KeyValue
        label="Target margin"
        value={
          row.targetMarginBps != null ? `${(row.targetMarginBps / 100).toFixed(0)}%` : "—"
        }
      />
      <KeyValue
        label="Rate card"
        value={row.rateCardVersion ?? row.rateCardId ?? "Test fixed rule"}
        mono
      />
      <KeyValue
        label="Pricing rule"
        value={row.pricingRuleId ?? "—"}
        mono
      />
      <KeyValue
        label="Wallet"
        value={
          balanceBefore != null && balanceAfter != null
            ? `${formatCurrency(balanceBefore)} → ${formatCurrency(balanceAfter)}`
            : "—"
        }
      />
      <KeyValue label="Ledger" value={row.ledgerEntryId ?? "—"} mono />
      <KeyValue label="Settlement" value={row.settlementStatus ?? "—"} />

      <h3 className="section-title">Related activity</h3>
      {auditEvents.length === 0 ? (
        <p className="muted">No correlated audit events for this request.</p>
      ) : (
        <ol className="audit-steps">
          {auditEvents
            .slice()
            .reverse()
            .map((event) => (
              <li key={event.id}>
                <strong>{String(event.detail?.stage ?? event.eventType)}</strong>
                <div className="muted small">{formatDate(event.createdAt)}</div>
              </li>
            ))}
        </ol>
      )}

      <details className="advanced-block">
        <summary>Technical details</summary>
        <KeyValue label="Tool" value={row.toolName ?? "—"} mono />
        <KeyValue label="Request ID" value={row.requestId ?? "—"} mono />
        <KeyValue label="Correlation ID" value={row.correlationId ?? "—"} mono />
        <KeyValue label="Usage ID" value={row.id} mono />
      </details>
    </>
  );
}

function formatUnderlyingCost(row: UsageRow): string {
  if (row.costBasis === "unknown" || (row.underlyingCostCents == null && row.underlyingCostMicros == null)) {
    return "Unavailable / not configured";
  }
  if (row.underlyingCostMicros != null && row.underlyingCostMicros > 0) {
    const label = row.costBasis === "estimated" ? "Estimated" : "Actual";
    return `${label}: £${(row.underlyingCostMicros / 1_000_000).toFixed(6)}`;
  }
  if (row.underlyingCostCents != null) {
    const label = row.costBasis === "estimated" ? "Estimated" : "Actual";
    return `${label}: ${formatCurrency(row.underlyingCostCents)}`;
  }
  return "Unavailable / not configured";
}

