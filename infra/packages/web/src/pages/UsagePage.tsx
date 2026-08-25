import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChartColumn } from "lucide-react";
import type { Company, UsageInteraction, UsageRecord } from "@infra/shared";
import { api } from "../api";
import {
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
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";
import { formatNumber } from "../lib/format";

type UsageRow = UsageRecord & {
  companyName: string;
  companySlug: string;
};

export default function UsagePage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [summary, setSummary] = useState<{
    requests: number;
    successful: number;
    failed: number;
    customerChargesCents: number;
    underlyingCostsCents: number | null;
    providerCostKnown?: boolean;
    grossProfitCents: number | null;
    grossMarginBps: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [sourceClient, setSourceClient] = useState("");
  const [successFilter, setSuccessFilter] = useState("");
  const [selected, setSelected] = useState<UsageRow | null>(null);
  const [view, setView] = useState<"interactions" | "operations">("interactions");
  const [interactions, setInteractions] = useState<UsageInteraction[]>([]);
  const [openInteraction, setOpenInteraction] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<
    Awaited<ReturnType<typeof api.getAuditEvents>>
  >([]);

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
    if (!selected) {
      setAuditEvents([]);
      return;
    }
    void (async () => {
      try {
        const events = await api.getAuditEvents(selected.companyId, 80);
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
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.companyName.toLowerCase().includes(q) ||
        (r.action ?? "").toLowerCase().includes(q) ||
        (r.toolName ?? "").toLowerCase().includes(q) ||
        (r.sourceClient ?? "").toLowerCase().includes(q) ||
        (r.requestId ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const totals = useMemo(() => {
    if (summary && !query.trim()) return summary;
    const requests = filtered.length;
    const successful = filtered.filter((r) => r.success !== false).length;
    const failed = filtered.filter((r) => r.success === false).length;
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
    return {
      requests,
      successful,
      failed,
      customerChargesCents,
      underlyingCostsCents,
      providerCostKnown: costsKnown,
      grossProfitCents,
      grossMarginBps:
        customerChargesCents > 0
          ? Math.round((grossProfitCents * 10_000) / customerChargesCents)
          : null,
    };
  }, [filtered, summary, query]);

  if (loading) return <LoadingState label="Loading usage…" />;
  if (error) {
    return <ErrorState title="Unable to load usage" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Usage"
        description="Customer charges, underlying provider cost, and margin from the same accounting data as Billing."
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
          label="Underlying provider cost"
          value={
            totals.providerCostKnown && totals.underlyingCostsCents != null
              ? formatCurrency(totals.underlyingCostsCents)
              : "Unavailable"
          }
          hint={
            totals.providerCostKnown
              ? undefined
              : "Shown when provider rate cards have measurable unit costs. Missing cost is not treated as £0."
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
        <MetricCard label="Successful requests" value={formatNumber(totals.successful)} />
        <MetricCard label="Failed requests" value={formatNumber(totals.failed)} />
      </MetricGrid>

      <FilterBar>
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
          <option value="failed">Failed</option>
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
          {interactions.map((item) => {
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
                            <td>{humaniseOperation(op.action ?? op.toolName ?? "Request")}</td>
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
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ChartColumn size={28} />}
          title="No usage recorded yet"
          description="Usage appears after a request passes through the INFRA gateway or MCP facade."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Company</th>
                <th>Client</th>
                <th>Operation</th>
                <th className="num">Charge</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
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
                  <td>{formatDate(row.recordedAt)}</td>
                  <td>
                    {row.companySlug ? (
                      <Link to={`/companies/${row.companySlug}`} onClick={(e) => e.stopPropagation()}>
                        {row.companyName}
                      </Link>
                    ) : (
                      row.companyName
                    )}
                  </td>
                  <td className="muted">{humanClient(row.sourceClient)}</td>
                  <td>{humaniseOperation(row.action ?? row.toolName ?? "Request")}</td>
                  <td className="num">
                    {row.customerChargeCents != null
                      ? formatCurrency(row.customerChargeCents)
                      : "—"}
                  </td>
                  <td>
                    <StatusBadge status={row.success !== false ? "completed" : "failed"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
      <KeyValue label="Company" value={row.companyName} />
      <KeyValue
        label="Operation"
        value={humaniseOperation(row.action ?? row.toolName ?? "Request")}
      />
      <KeyValue
        label="Status"
        value={<StatusBadge status={row.success !== false ? "completed" : "failed"} />}
      />
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

function humaniseOperation(value: string): string {
  if (value.includes("knowledge.search") || value.includes("search_company_knowledge")) {
    return "Knowledge Search";
  }
  if (value.includes("knowledge.read")) return "Knowledge Read";
  return value.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanClient(value: string | null | undefined): string {
  if (!value) return "—";
  if (value === "chatgpt") return "ChatGPT";
  if (value === "claude") return "Claude";
  return value;
}
