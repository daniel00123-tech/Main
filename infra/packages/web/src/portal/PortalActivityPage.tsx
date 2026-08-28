import { useEffect, useMemo, useState } from "react";
import type { AuditEvent } from "@infra/shared";
import {
  buildCustomerActivityList,
  filterCustomerActivity,
  type CustomerActivityFilter,
} from "@infra/shared";
import { api } from "../api";
import {
  AdvancedDetails,
  Drawer,
  EmptyState,
  FilterBar,
  FilterChip,
  KeyValue,
  LoadingState,
  MobileRecordCard,
  MobileRecordList,
  SearchInput,
  SectionCard,
  ShowMoreFooter,
  useIsMobile,
} from "../components";
import { formatFullDate, formatRelativeTime } from "../lib/format";
import { PortalPageBody, PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalActivityPage() {
  const { company, loading } = usePortalCompany();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CustomerActivityFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const activityItems = useMemo(() => buildCustomerActivityList(events, 200), [events]);

  const filtered = useMemo(
    () => filterCustomerActivity(activityItems, filter, query),
    [activityItems, filter, query],
  );

  const visible = filtered.slice(0, displayLimit);
  const selected = activityItems.find((item) => item.id === selectedId) ?? null;
  const selectedEvent = events.find((event) => event.id === selectedId) ?? null;

  useEffect(() => {
    setDisplayLimit(30);
  }, [query, filter]);

  if (loading || !company) {
    return <LoadingState label="Loading activity…" />;
  }

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="Activity"
        description="Important company events — sign-ins, syncs, approvals, and billing."
      />

      <PortalPageBody
        loading={eventsLoading}
        error={eventsError}
        loadingLabel="Loading activity…"
        errorTitle="We couldn't load your activity"
        onRetry={() => window.location.reload()}
      >
        <FilterBar>
          <SearchInput value={query} onChange={setQuery} placeholder="Search activity…" />
        </FilterBar>

        <div className="filter-chips portal-activity-filters">
          {(
            [
              ["all", "All"],
              ["users", "Users"],
              ["ai", "AI"],
              ["connectors", "Connections"],
              ["actions", "Approvals"],
              ["billing", "Billing"],
            ] as const
          ).map(([id, label]) => (
            <FilterChip key={id} active={filter === id} onClick={() => setFilter(id)}>
              {label}
            </FilterChip>
          ))}
        </div>

        <SectionCard title="Recent activity">
          {visible.length === 0 ? (
            <EmptyState
              title="No activity yet"
              description="Sign-ins, system syncs, approvals, and billing updates will appear here."
            />
          ) : isMobile ? (
            <MobileRecordList>
              {visible.map((item) => (
                <MobileRecordCard key={item.id} onClick={() => setSelectedId(item.id)}>
                  <div className="mobile-record-header">
                    <div className="mobile-record-title">{item.title}</div>
                    <span className="muted small">{formatRelativeTime(item.createdAt)}</span>
                  </div>
                  <p className="muted small" style={{ margin: "4px 0 0" }}>
                    {item.description}
                  </p>
                </MobileRecordCard>
              ))}
            </MobileRecordList>
          ) : (
            <div className="compact-list">
              {visible.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="action-list-row"
                  onClick={() => setSelectedId(item.id)}
                >
                  <div>
                    <div className="action-list-title">{item.title}</div>
                    <div className="action-list-sub">{item.description}</div>
                  </div>
                  <div className="muted small">{formatRelativeTime(item.createdAt)}</div>
                </button>
              ))}
            </div>
          )}

          <ShowMoreFooter
            shown={visible.length}
            total={filtered.length}
            onShowMore={() => setDisplayLimit((n) => n + 30)}
          />
        </SectionCard>
      </PortalPageBody>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelectedId(null)}
        title={selected ? `${selected.title}` : "Activity details"}
      >
        {selected ? (
          <>
            <KeyValue label="When" value={formatFullDate(selected.createdAt)} />
            <KeyValue label="Summary" value={selected.description} />
            {selectedEvent ? (
              <AdvancedDetails label="Technical details">
                <KeyValue label="Event type" value={selectedEvent.eventType} mono />
                {selectedEvent.actor ? (
                  <KeyValue label="Actor" value={selectedEvent.actor} mono />
                ) : null}
                {selectedEvent.resourceId ? (
                  <KeyValue label="Resource ID" value={selectedEvent.resourceId} mono />
                ) : null}
              </AdvancedDetails>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
