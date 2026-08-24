import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChartColumn } from "lucide-react";
import type { Company, UsageRecord } from "@infra/shared";
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
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";
import { formatNumber } from "../lib/format";

type UsageRow = {
  id: string;
  companyName: string;
  companySlug: string;
  recordedAt: string;
  operation: string;
  toolName: string | null;
  sourceClient: string | null;
  success: boolean;
  costCents: number | null;
  chargeCents: number | null;
  correlationId: string | null;
  durationMs: number | null;
};

export default function UsagePage() {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<UsageRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const companies = await api.getCompanies();
      const collected: UsageRow[] = [];
      await Promise.all(
        companies.map(async (company: Company) => {
          try {
            const usage = await api.getCompanyUsage(company.slug, 50);
            for (const record of usage.records) {
              collected.push(mapRecord(company, record));
            }
          } catch {
            /* skip */
          }
        }),
      );
      collected.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      setRows(collected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load usage");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.companyName.toLowerCase().includes(q) ||
        r.operation.toLowerCase().includes(q) ||
        (r.toolName ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const totals = useMemo(() => {
    const requests = filtered.length;
    const failed = filtered.filter((r) => !r.success).length;
    const charge = filtered.reduce((sum, r) => sum + (r.chargeCents ?? 0), 0);
    const cost = filtered.reduce((sum, r) => sum + (r.costCents ?? 0), 0);
    return { requests, failed, charge, cost };
  }, [filtered]);

  if (loading) return <LoadingState label="Loading usage…" />;
  if (error) {
    return <ErrorState title="Unable to load usage" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Usage"
        description="Understand how INFRA is being used across companies."
      />

      <MetricGrid cols={4}>
        <MetricCard label="Requests" value={formatNumber(totals.requests)} hint="Loaded recent records" />
        <MetricCard
          label="Customer charges"
          value={totals.charge > 0 ? formatCurrency(totals.charge) : "—"}
          hint={totals.charge > 0 ? "From recorded charges" : "No charge data in loaded records"}
        />
        <MetricCard
          label="Underlying cost"
          value={totals.cost > 0 ? formatCurrency(totals.cost) : "—"}
          hint={totals.cost > 0 ? "Provider cost where recorded" : "Cost not configured on all records"}
        />
        <MetricCard label="Failed" value={formatNumber(totals.failed)} />
      </MetricGrid>

      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search usage…" className="grow" />
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<ChartColumn size={28} />}
          title="No usage recorded yet"
          description="Usage appears after the first request passes through INFRA."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Company</th>
                <th>Action</th>
                <th>Source</th>
                <th className="num">Charge</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} style={{ cursor: "pointer" }} onClick={() => setSelected(row)}>
                  <td>{formatDate(row.recordedAt)}</td>
                  <td>
                    <Link to={`/companies/${row.companySlug}`} onClick={(e) => e.stopPropagation()}>
                      {row.companyName}
                    </Link>
                  </td>
                  <td>{humaniseOperation(row.operation)}</td>
                  <td className="muted">{row.sourceClient ?? row.toolName ?? "—"}</td>
                  <td className="num">
                    {row.chargeCents != null ? formatCurrency(row.chargeCents) : "—"}
                  </td>
                  <td>
                    <StatusBadge status={row.success ? "completed" : "failed"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Usage details">
        {selected ? (
          <>
            <KeyValue label="Company" value={selected.companyName} />
            <KeyValue label="Action" value={humaniseOperation(selected.operation)} />
            <KeyValue label="Time" value={formatDate(selected.recordedAt)} />
            <KeyValue label="Status" value={<StatusBadge status={selected.success ? "completed" : "failed"} />} />
            <KeyValue
              label="Charge"
              value={selected.chargeCents != null ? formatCurrency(selected.chargeCents) : "—"}
            />
            <KeyValue
              label="Cost"
              value={selected.costCents != null ? formatCurrency(selected.costCents) : "Not recorded"}
            />
            <KeyValue
              label="Latency"
              value={selected.durationMs != null ? `${selected.durationMs}ms` : "—"}
            />
            <details className="advanced-block">
              <summary>Technical details</summary>
              <KeyValue label="Request ID" value={selected.correlationId ?? selected.id} mono />
              <KeyValue label="Tool" value={selected.toolName ?? "—"} mono />
              <KeyValue label="Source" value={selected.sourceClient ?? "—"} />
            </details>
          </>
        ) : null}
      </Drawer>
    </>
  );
}

function mapRecord(company: Company, record: UsageRecord): UsageRow {
  return {
    id: record.id,
    companyName: company.name,
    companySlug: company.slug,
    recordedAt: record.recordedAt,
    operation: record.action ?? record.toolName ?? record.resourceType ?? "Request",
    toolName: record.toolName ?? null,
    sourceClient: record.sourceClient ?? null,
    success: record.success !== false,
    costCents: record.underlyingCostCents ?? null,
    chargeCents: record.customerChargeCents ?? null,
    correlationId: record.correlationId ?? null,
    durationMs: record.durationMs ?? null,
  };
}

function humaniseOperation(value: string): string {
  return value.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
