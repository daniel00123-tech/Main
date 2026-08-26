import { useEffect, useMemo, useState } from "react";
import type { AuditEvent } from "@infra/shared";
import { api } from "../api";
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
  SearchInput,
  SectionCard,
  ShowMoreFooter,
  StatusBadge,
  AdvancedDetails,
  useIsMobile,
} from "../components";
import {
  formatFullDate,
  formatRelativeTime,
  humanAuditDetail,
  humanEventLabel,
  integrationLabel,
} from "../lib/format";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

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

type ActivityFilter = "all" | "users" | "ai" | "connectors" | "billing" | "actions";

function eventCategory(event: AuditEvent): ActivityFilter {
  const type = event.eventType;
  if (type.startsWith("auth.") || type.startsWith("user.")) return "users";
  if (type.startsWith("mcp.") || type.startsWith("ai_connection.")) return "ai";
  if (type.startsWith("connector.")) return "connectors";
  if (type.startsWith("wallet.") || type.startsWith("payment.") || type.startsWith("billing.")) {
    return "billing";
  }
  if (type.startsWith("action_plan.")) return "actions";
  return "all";
}

export default function PortalActivityPage() {
  const { company, overview, loading, error } = usePortalCompany();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [displayLimit, setDisplayLimit] = useState(30);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        setEventsError(null);
        const list = await api.getAuditEvents({ companyId: company.id, limit: 200 });
        setEvents(list);
      } catch (err) {
        setEventsError(err instanceof Error ? err.message : "Unable to load activity");
      } finally {
        setEventsLoading(false);
      }
    })();
  }, [company]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = events.length > 0 ? events : overview?.recentAuditEvents ?? [];
    return base.filter((event) => {
      if (filter !== "all" && eventCategory(event) !== filter) return false;
      if (!q) return true;
      return (
        humanEventLabel(event.eventType).toLowerCase().includes(q) ||
        humanAuditDetail(event).toLowerCase().includes(q)
      );
    });
  }, [events, overview, query, filter]);

  const visible = filtered.slice(0, displayLimit);

  useEffect(() => {
    setDisplayLimit(30);
  }, [query, filter]);

  if (loading || eventsLoading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load activity" description={error ?? undefined} />;
  }

  return (
    <>
      <PortalPageHeader
        title="Activity"
        description={`Audit trail for ${company.name} — who did what and when.`}
      />

      {eventsError ? <ErrorState title="Unable to load full history" description={eventsError} /> : null}

      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search activity…" />
      </FilterBar>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {(
          [
            ["all", "All"],
            ["users", "Users"],
            ["ai", "AI"],
            ["connectors", "Connections"],
            ["actions", "Actions"],
            ["billing", "Billing"],
          ] as const
        ).map(([id, label]) => (
          <FilterChip key={id} active={filter === id} onClick={() => setFilter(id)}>
            {label}
          </FilterChip>
        ))}
      </div>

      <SectionCard title="Recent events">
        {visible.length === 0 ? (
          <EmptyState title="No activity yet" description="Company events will appear here." />
        ) : isMobile ? (
          <MobileRecordList>
            {visible.map((event) => {
              const result = auditResult(event);
              return (
                <MobileRecordCard key={event.id} onClick={() => setSelected(event)}>
                  <div className="mobile-record-header">
                    <div className="mobile-record-title">{humanEventLabel(event.eventType)}</div>
                    <StatusBadge status={result.status} label={result.label} />
                  </div>
                  <dl className="mobile-record-meta">
                    <div>
                      <dt>Detail</dt>
                      <dd>{humanAuditDetail(event)}</dd>
                    </div>
                    <div>
                      <dt>When</dt>
                      <dd>{formatRelativeTime(event.createdAt)}</dd>
                    </div>
                  </dl>
                </MobileRecordCard>
              );
            })}
          </MobileRecordList>
        ) : (
          <div className="compact-list">
            {visible.map((event) => {
              const result = auditResult(event);
              return (
                <button
                  key={event.id}
                  type="button"
                  className="action-list-row"
                  onClick={() => setSelected(event)}
                >
                  <div>
                    <div className="action-list-title">{humanEventLabel(event.eventType)}</div>
                    <div className="action-list-sub">{humanAuditDetail(event)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <StatusBadge status={result.status} label={result.label} />
                    <div className="muted small">{formatRelativeTime(event.createdAt)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <ShowMoreFooter
          shown={visible.length}
          total={filtered.length}
          onShowMore={() => setDisplayLimit((n) => n + 30)}
        />
      </SectionCard>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? humanEventLabel(selected.eventType) : "Event details"}
      >
        {selected ? (
          <>
            <KeyValue label="When" value={formatFullDate(selected.createdAt)} />
            <KeyValue label="Summary" value={humanAuditDetail(selected)} />
            <KeyValue
              label="System"
              value={integrationLabel(
                String(selected.detail?.action ?? ""),
                selected.resourceType ?? undefined,
              )}
            />
            <KeyValue label="Result" value={<StatusBadge {...auditResult(selected)} />} />
            <AdvancedDetails label="Technical details">
              <KeyValue label="Event type" value={selected.eventType} mono />
              {selected.resourceType ? (
                <KeyValue label="Resource type" value={selected.resourceType} mono />
              ) : null}
              {selected.resourceId ? (
                <KeyValue label="Resource ID" value={selected.resourceId} mono />
              ) : null}
              {selected.actor ? <KeyValue label="Actor" value={selected.actor} mono /> : null}
            </AdvancedDetails>
          </>
        ) : null}
      </Drawer>
    </>
  );
}
