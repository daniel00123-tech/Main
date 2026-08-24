import { useEffect, useState } from "react";
import { api } from "../api";
import type { InfraUser } from "@infra/shared";
import { ErrorState, LoadingState, PageHeader, SectionCard, StatusBadge } from "../components";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalTeamPage() {
  const { company, membership, user, loading, error } = usePortalCompany();
  const [team, setTeam] = useState<InfraUser[]>([]);
  const [roles, setRoles] = useState<Awaited<ReturnType<typeof api.getRolePresets>>>([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [teamError, setTeamError] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        const [users, rolePresets] = await Promise.all([
          api.getUsers(company.id),
          api.getRolePresets(),
        ]);
        setTeam(users);
        setRoles(rolePresets);
      } catch (err) {
        setTeamError(err instanceof Error ? err.message : "Failed to load team");
      } finally {
        setTeamLoading(false);
      }
    })();
  }, [company]);

  if (loading || teamLoading) return <LoadingState />;
  if (error || teamError || !company || !user) {
    return <ErrorState message={error ?? teamError ?? "Team unavailable"} />;
  }

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={`Manage who can access ${company.name} AI tools and what they can do.`}
      />

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header-row">
          <h3>Team members</h3>
          <span className="prototype-badge">Invite user — coming soon</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {team.map((member) => {
              const memberRole =
                member.memberships.find((item) => item.companyId === company.id)?.role ??
                "—";
              return (
                <tr key={member.id}>
                  <td>
                    {member.displayName}
                    {member.id === user.userId ? <span className="muted"> (you)</span> : null}
                  </td>
                  <td>{member.email}</td>
                  <td>{memberRole}</td>
                  <td>
                    <StatusBadge value={member.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SectionCard title="Role presets">
        <table className="table">
          <thead>
            <tr>
              <th>Role</th>
              <th>What they can do</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.role}>
                <td>{role.displayName}</td>
                <td className="muted">{role.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      <div className="card info-banner" style={{ marginTop: 24 }}>
        Your current role for {company.name} is <strong>{membership?.role}</strong>.
        Permissions are enforced server-side for MCP and connector actions.
      </div>
    </>
  );
}
