import { useEffect, useMemo, useState } from "react";
import type { AuditEvent, Company } from "@infra/shared";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChip,
  KeyValue,
  LoadingState,
  MobileRecordCard,
  MobileRecordList,
  PageHeader,
  SearchInput,
  ShowMoreFooter,
  StatusBadge,
  formatDate,
} from "../components";
import {
  formatFullDate,
  formatRelativeTime,
  humanActor,
  humanEventLabel,
  integrationLabel,
} from "../lib/format";

function auditResult(event: AuditEvent): { status: string; label: string } {
  const type = event.eventType.toLowerCase();
  if (type.includes("failed") || type.includes("denied")) {
    return { status: "failed", label: "Failed" };
  }
  if (type.includes("started") || type.includes("pending")) {
    return { status: "warning", label: "In progress" };
  }
  return { status: "healthy", label: "Completed" };
}

function auditIntegration(event: AuditEvent): string {
  const detail = event.detail ?? {};
  const action = String(detail.action ?? detail.toolName ?? event.resourceType ?? "");
  return integrationLabel(action, event.resourceId ?? undefined);
}

function formatActorDisplay(event: AuditEvent): string {
  const human = humanActor(event.actor);
  const detail = event.detail ?? {};
  const client = detail.sourceClient ?? detail.client;
  if (client && human !== "System" && human !== "System automation") {
    const clientLabel =
      String(client) === "chatgpt"
        ? "ChatGPT"
        : String(client) === "claude"
          ? "Claude"
          : String(client);
    if (!human.includes(clientLabel)) return `${human} via ${clientLabel}`;
  }
  return human;
}

export default function AuditLogPage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<
    "all" | "auth" | "mcp" | "connector" | "billing" | "company"
  >("all");
  const [companyFilter, setCompanyFilter] = useState("");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [displayLimit, setDisplayLimit] = useState(30);

  useEffect(() => {
    setCompanyFilter(scopeCompanyId ?? "");
  }, [scopeCompanyId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [eventList, companyList] = await Promise.all([
        api.getAuditEvents({
          limit: 200,
          category: filter === "all" ? undefined : filter,
          companyId: companyFilter || undefined,
        }),
        api.getCompanies(),
      ]);
      setEvents(eventList);
      setCompanies(companyList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, companyFilter]);

  useEffect(() => {
    setDisplayLimit(30);
  }, [query, filter, companyFilter]);

  const companyById = useMemo(
    () => new Map(companies.map((c) => [c.id, c])),
    [companies],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((event) => {
      if (!q) return true;
      const company = event.companyId ? companyById.get(event.companyId)?.name ?? "" : "Platform";
      return (
        humanEventLabel(event.eventType).toLowerCase().includes(q) ||
        formatActorDisplay(event).toLowerCase().includes(q) ||
        event.eventType.toLowerCase().includes(q) ||
        company.toLowerCase().includes(q)
      );
    });
  }, [events, query, companyById]);

  if (loading) return <LoadingState label="Loading audit log…" />;
  if (error) {
    return (
      <ErrorState title="Unable to load audit log" description={error} onRetry={() => void load()} />
    );
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Investigation tool for platform activity — who did what, when, and with what result."
      />

      <FilterBar className="filter-bar-mobile-stack">
        <SearchInput value={query} onChange={setQuery} placeholder="Search events…" className="grow" />
        <select
          className="select"
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          aria-label="Filter by company"
        >
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="filter-chips">
          {(
            [
              ["all", "All"],
              ["auth", "Auth"],
              ["mcp", "Gateway"],
              ["connector", "Connectors"],
              ["billing", "Billing"],
              ["company", "Company"],
            ] as const
          ).map(([id, label]) => (
            <FilterChip key={id} active={filter === id} onClick={() => setFilter(id)}>
              {label}
            </FilterChip>
          ))}
        </div>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState title="No audit events" description="Events will appear as platform activity occurs." />
      ) : (
        <>
        <div className="table-wrap desktop-only">
          <table className="table compact">
            <thead>
              <tr>
                <th>Date & time</th>
                <th>User / source</th>
                <th>Company</th>
                <th>Action</th>
                <th>Item</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, displayLimit).map((event) => {
                const company = event.companyId
                  ? companyById.get(event.companyId)?.name ?? "—"
                  : "Platform";
                const result = auditResult(event);
                return (
                  <tr
                    key={event.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => setSelected(event)}
                  >
                    <td title={formatFullDate(event.createdAt)}>
                      {formatRelativeTime(event.createdAt)}
                      <div className="muted small">{formatDate(event.createdAt)}</div>
                    </td>
                    <td>{formatActorDisplay(event)}</td>
                    <td>{company}</td>
                    <td>
                      <strong>{humanEventLabel(event.eventType)}</strong>
                    </td>
                    <td className="muted">{auditIntegration(event)}</td>
                    <td>
                      <StatusBadge status={result.status} label={result.label} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mobile-only">
          <MobileRecordList>
            {filtered.slice(0, displayLimit).map((event) => {
              const company = event.companyId
                ? companyById.get(event.companyId)?.name ?? "—"
                : "Platform";
              const result = auditResult(event);
              return (
                <MobileRecordCard key={event.id} onClick={() => setSelected(event)}>
                  <div className="mobile-record-header">
                    <div>
                      <div className="ledger-row-primary">{formatRelativeTime(event.createdAt)}</div>
                      <div className="ledger-row-meta">{formatActorDisplay(event)}</div>
                    </div>
                    <StatusBadge status={result.status} label={result.label} />
                  </div>
                  <p className="small" style={{ margin: "8px 0 0" }}>
                    <strong>{humanEventLabel(event.eventType)}</strong>
                  </p>
                  <div className="muted small">
                    {company} · {auditIntegration(event)}
                  </div>
                </MobileRecordCard>
              );
            })}
          </MobileRecordList>
        </div>

        <ShowMoreFooter
          shown={Math.min(displayLimit, filtered.length)}
          total={filtered.length}
          onShowMore={() => setDisplayLimit((n) => n + 30)}
        />
        </>
      )}

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Event details">
        {selected ? (
          <>
            <KeyValue label="Action" value={humanEventLabel(selected.eventType)} />
            <KeyValue label="User / source" value={formatActorDisplay(selected)} />
            <KeyValue label="Raw actor" value={selected.actor} />
            <KeyValue label="Time" value={formatFullDate(selected.createdAt)} />
            <KeyValue
              label="Company"
              value={
                selected.companyId
                  ? companyById.get(selected.companyId)?.name ?? selected.companyId
                  : "Platform"
              }
            />
            <KeyValue label="Integration" value={auditIntegration(selected)} />
            <KeyValue label="Resource" value={selected.resourceType ?? "—"} />
            <KeyValue
              label="Result"
              value={
                <StatusBadge
                  status={auditResult(selected).status}
                  label={auditResult(selected).label}
                />
              }
            />
            <details className="advanced-block">
              <summary>Technical details</summary>
              <KeyValue label="Event type" value={selected.eventType} mono />
              <KeyValue label="Event ID" value={selected.id} mono />
              <KeyValue label="Resource ID" value={selected.resourceId ?? "—"} mono />
              {Object.keys(selected.detail ?? {}).length > 0 ? (
                <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {JSON.stringify(selected.detail, null, 2)}
                </pre>
              ) : null}
            </details>
          </>
        ) : null}
      </Drawer>
    </>
  );
}
