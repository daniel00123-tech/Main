import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import type { CompanyRole, InfraUser } from "@infra/shared";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
} from "../components";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalTeamPage() {
  const { company, membership, user, loading, error } = usePortalCompany();
  const [team, setTeam] = useState<InfraUser[]>([]);
  const [roles, setRoles] = useState<Awaited<ReturnType<typeof api.getRolePresets>>>([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyRole>("office_staff");
  const [inviteResult, setInviteResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canManage =
    user?.isPlatformAdmin ||
    membership?.role === "company_admin" ||
    membership?.role === "director";

  async function refresh() {
    if (!company) return;
    const [users, rolePresets] = await Promise.all([
      api.getUsers(company.id),
      api.getRolePresets(),
    ]);
    setTeam(users);
    setRoles(rolePresets);
  }

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        setTeamError(err instanceof Error ? err.message : "Failed to load team");
      } finally {
        setTeamLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);

  async function onInvite(event: FormEvent) {
    event.preventDefault();
    if (!company) return;
    setBusy(true);
    setInviteResult(null);
    try {
      const result = await api.inviteUser(company.slug, {
        email: inviteEmail,
        displayName: inviteName,
        role: inviteRole,
      });
      setInviteResult(
        `Invite created. Share this one-time setup link (expires soon): ${result.setupUrl}`,
      );
      setInviteEmail("");
      setInviteName("");
      await refresh();
    } catch (err) {
      setInviteResult(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(member: InfraUser) {
    if (!company) return;
    const next = member.status === "active" ? "disabled" : "active";
    if (!window.confirm(`${next === "disabled" ? "Disable" : "Reactivate"} ${member.email}?`)) {
      return;
    }
    await api.setUserStatus(company.slug, member.id, next);
    await refresh();
  }

  async function changeRole(member: InfraUser, role: CompanyRole) {
    if (!company) return;
    await api.setUserRole(company.slug, member.id, role);
    await refresh();
  }

  if (loading || teamLoading) return <LoadingState />;
  if (error || teamError || !company || !user) {
    return <ErrorState title="Unable to load team" description={error ?? teamError ?? undefined} />;
  }

  return (
    <>
      <PageHeader
        title="Team"
        description={`People who can access ${company.name} through INFRA.`}
      />

      {canManage ? (
        <SectionCard title="Invite user">
          <form className="login-form" onSubmit={(e) => void onInvite(e)}>
            <label>
              Name
              <input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                required
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as CompanyRole)}
              >
                {roles.map((role) => (
                  <option key={role.role} value={role.role}>
                    {role.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? "Creating invite..." : "Create invite"}
            </button>
          </form>
          {inviteResult ? <p className="info-banner">{inviteResult}</p> : null}
        </SectionCard>
      ) : null}

      <div className="card" style={{ marginTop: 24, marginBottom: 24 }}>
        <div className="card-header-row">
          <h3>Team members</h3>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Last login</th>
              <th>Status</th>
              {canManage ? <th>Actions</th> : null}
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
                  <td>
                    {canManage && member.id !== user.userId ? (
                      <select
                        value={memberRole}
                        onChange={(e) =>
                          void changeRole(member, e.target.value as CompanyRole)
                        }
                      >
                        {roles.map((role) => (
                          <option key={role.role} value={role.role}>
                            {role.displayName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      memberRole
                    )}
                  </td>
                  <td>
                    {"lastLoginAt" in member && member.lastLoginAt
                      ? formatDate(String(member.lastLoginAt))
                      : "—"}
                  </td>
                  <td>
                    <StatusBadge value={member.status} />
                  </td>
                  {canManage ? (
                    <td>
                      {member.id !== user.userId ? (
                        <button
                          className="button button-small"
                          type="button"
                          onClick={() => void toggleStatus(member)}
                        >
                          {member.status === "active" ? "Disable" : "Reactivate"}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  ) : null}
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
    </>
  );
}
