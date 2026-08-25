import { useEffect, useMemo, useState } from "react";
import type { AuditEvent, Company } from "@infra/shared";
import { api } from "../api";
import {
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChip,
  KeyValue,
  LoadingState,
  PageHeader,
  SearchInput,
  formatDate,
} from "../components";
import { formatFullDate, formatRelativeTime, humanEventLabel } from "../lib/format";

export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "auth" | "mcp" | "connector" | "billing">("all");
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [eventList, companyList] = await Promise.all([
        api.getAuditEvents(undefined, 100),
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
  }, []);

  const companyById = useMemo(
    () => new Map(companies.map((c) => [c.id, c])),
    [companies],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((event) => {
      if (filter !== "all" && !event.eventType.startsWith(filter)) return false;
      if (!q) return true;
      const company = event.companyId ? companyById.get(event.companyId)?.name ?? "" : "platform";
      return (
        humanEventLabel(event.eventType).toLowerCase().includes(q) ||
        event.actor.toLowerCase().includes(q) ||
        event.eventType.toLowerCase().includes(q) ||
        company.toLowerCase().includes(q)
      );
    });
  }, [events, query, filter, companyById]);

  if (loading) return <LoadingState label="Loading audit log…" />;
  if (error) {
    return <ErrorState title="Unable to load audit log" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Who did what, across the INFRA control plane."
      />

      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search events…" className="grow" />
        <div className="filter-chips">
          {(
            [
              ["all", "All"],
              ["auth", "Auth"],
              ["mcp", "Gateway"],
              ["connector", "Connectors"],
              ["billing", "Billing"],
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
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Company</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => {
                const company = event.companyId
                  ? companyById.get(event.companyId)?.name ?? "—"
                  : "Platform";
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
                    <td>{event.actor}</td>
                    <td>
                      <strong>{humanEventLabel(event.eventType)}</strong>
                    </td>
                    <td>{company}</td>
                    <td className="muted">
                      {event.resourceType ?? "—"}
                      {event.resourceId ? (
                        <div className="mono small">{truncate(event.resourceId)}</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Event details">
        {selected ? (
          <>
            <KeyValue label="Action" value={humanEventLabel(selected.eventType)} />
            <KeyValue label="Actor" value={selected.actor} />
            <KeyValue label="Time" value={formatFullDate(selected.createdAt)} />
            <KeyValue
              label="Company"
              value={
                selected.companyId
                  ? companyById.get(selected.companyId)?.name ?? selected.companyId
                  : "Platform"
              }
            />
            <KeyValue label="Resource" value={selected.resourceType ?? "—"} />
            <details className="advanced-block" open>
              <summary>Technical details</summary>
              <KeyValue label="Event" value={selected.eventType} mono />
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

function truncate(value: string, max = 24): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
