import {
  ActivityFeed,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
} from "../components";
import { formatRelativeTime, humanEventLabel } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalActivityPage() {
  const { company, overview, loading, error } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !overview) {
    return <ErrorState title="Unable to load activity" description={error ?? undefined} />;
  }

  return (
    <>
      <PageHeader
        title="Activity"
        description={`${company.name} · who did what in this company`}
      />
      <SectionCard title="Recent events">
        <ActivityFeed
          items={overview.recentAuditEvents.map((event) => ({
            id: event.id,
            title: humanEventLabel(event.eventType),
            description: event.actor,
            meta: formatRelativeTime(event.createdAt),
          }))}
        />
      </SectionCard>
    </>
  );
}
