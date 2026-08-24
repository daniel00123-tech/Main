import { PageHeader, SectionCard, StatusBadge } from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { ErrorState, LoadingState } from "../components";

export default function PortalSettingsPage() {
  const { company, membership, loading, error } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState message={error ?? "Settings unavailable"} />;
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Company profile and preferences." />

      <div className="grid grid-2">
        <SectionCard title="Company profile">
          <table className="table compact">
            <tbody>
              <tr>
                <td>Company name</td>
                <td>{company.name}</td>
              </tr>
              <tr>
                <td>Domain</td>
                <td>{company.primaryDomain ?? "—"}</td>
              </tr>
              <tr>
                <td>Status</td>
                <td>
                  <StatusBadge value={company.status} />
                </td>
              </tr>
              <tr>
                <td>Your role</td>
                <td>{membership?.role?.replace(/_/g, " ") ?? "—"}</td>
              </tr>
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Advanced (future)">
          <p className="muted">
            White-labelling, custom domains, and advanced MCP configuration will appear here.
            Technical MCP details remain available to platform administrators.
          </p>
        </SectionCard>
      </div>
    </>
  );
}
