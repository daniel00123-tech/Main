import {
  ErrorState,
  KeyValue,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";
import { humanRole } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalSettingsPage() {
  const { company, membership, loading, error } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load settings" description={error ?? undefined} />;
  }

  return (
    <>
      <PageHeader title="Settings" description="Company profile and preferences." />

      <div className="grid grid-2">
        <SectionCard title="Company profile">
          <KeyValue label="Company" value={company.name} />
          <KeyValue label="Domain" value={company.primaryDomain ?? "—"} />
          <KeyValue label="Status" value={<StatusBadge status={company.status} />} />
          <KeyValue label="Your role" value={humanRole(membership?.role)} />
        </SectionCard>

        <SectionCard title="Coming soon">
          <Notice tone="info">
            Branding, custom domains, and notification preferences will appear here when available.
          </Notice>
        </SectionCard>
      </div>
    </>
  );
}
