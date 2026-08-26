import { FormEvent, useEffect, useMemo, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { api } from "../api";
import type { CompanyRole, InfraUser } from "@infra/shared";
import {
  Button,
  CollapsibleBlock,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Modal,
  Notice,
  SectionCard,
  StatusBadge,
  formatDate,
  useIsMobile,
} from "../components";
import { humanRole } from "../lib/format";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalUsersPage() {
  const { company, membership, user, loading, error } = usePortalCompany();
  const [team, setTeam] = useState<InfraUser[]>([]);
  const [roles, setRoles] = useState<Awaited<ReturnType<typeof api.getRolePresets>>>([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyRole>("office_staff");
  const [inviteResult, setInviteResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<InfraUser | null>(null);
  const isMobile = useIsMobile();

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
        setTeamError(err instanceof Error ? err.message : "Failed to load users");
      } finally {
        setTeamLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);

  const activeCount = team.filter((m) => m.status === "active").length;

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
      setInviteResult(result.setupUrl);
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
    setSelected(null);
  }

  async function changeRole(member: InfraUser, role: CompanyRole) {
    if (!company) return;
    await api.setUserRole(company.slug, member.id, role);
    await refresh();
  }

  const roleDescription = useMemo(() => {
    if (!selected || !company) return null;
    const memberRole =
      selected.memberships.find((item) => item.companyId === company.id)?.role ?? null;
    return roles.find((r) => r.role === memberRole)?.description ?? null;
  }, [selected, company, roles]);

  if (loading || teamLoading) return <LoadingState />;
  if (error || teamError || !company || !user) {
    return <ErrorState title="Unable to load users" description={error ?? teamError ?? undefined} />;
  }

  return (
    <>
      <PortalPageHeader
        title="Users"
        description={`${activeCount} active · People who can access ${company.name}`}
        actions={
          canManage ? (
            <Button type="button" variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus size={16} style={{ marginRight: 6 }} aria-hidden />
              Invite user
            </Button>
          ) : null
        }
      />

      <SectionCard title="Team members">
        {team.length === 0 ? (
          <EmptyState
            icon={<Users size={28} />}
            title="Invite your team to start using INFRA"
            description="Add colleagues so they can access your company portal."
            action={
              canManage ? (
                <Button type="button" variant="primary" onClick={() => setInviteOpen(true)}>
                  Invite user
                </Button>
              ) : undefined
            }
          />
        ) : isMobile ? (
          <div className="mobile-record-list">
            {team.map((member) => {
              const memberRole =
                member.memberships.find((item) => item.companyId === company.id)?.role ?? "—";
              return (
                <button
                  key={member.id}
                  type="button"
                  className="mobile-record-card"
                  onClick={() => setSelected(member)}
                >
                  <div className="mobile-record-header">
                    <div className="mobile-record-title">
                      {member.displayName}
                      {member.id === user.userId ? " (you)" : ""}
                    </div>
                    <StatusBadge status={member.status} />
                  </div>
                  <dl className="mobile-record-meta">
                    <div>
                      <dt>Email</dt>
                      <dd>{member.email}</dd>
                    </div>
                    <div>
                      <dt>Role</dt>
                      <dd>{humanRole(String(memberRole))}</dd>
                    </div>
                    <div>
                      <dt>Last active</dt>
                      <dd>
                        {"lastLoginAt" in member && member.lastLoginAt
                          ? formatDate(String(member.lastLoginAt))
                          : "—"}
                      </dd>
                    </div>
                  </dl>
                </button>
              );
            })}
          </div>
        ) : (
          <DataTable
            rows={team.map((member) => ({
              id: member.id,
              member,
              memberRole:
                member.memberships.find((item) => item.companyId === company.id)?.role ?? "—",
            }))}
            columns={[
              {
                key: "name",
                header: "Name",
                render: (row) => (
                  <>
                    {(row.member as InfraUser).displayName}
                    {(row.member as InfraUser).id === user.userId ? (
                      <span className="muted"> (you)</span>
                    ) : null}
                  </>
                ),
              },
              {
                key: "email",
                header: "Email",
                render: (row) => (row.member as InfraUser).email,
              },
              {
                key: "role",
                header: "Role",
                render: (row) => {
                  const member = row.member as InfraUser;
                  const memberRole = String(row.memberRole);
                  if (canManage && member.id !== user.userId) {
                    return (
                      <select
                        className="input"
                        value={memberRole}
                        onChange={(e) => void changeRole(member, e.target.value as CompanyRole)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {roles.map((role) => (
                          <option key={role.role} value={role.role}>
                            {role.displayName}
                          </option>
                        ))}
                      </select>
                    );
                  }
                  return humanRole(memberRole);
                },
              },
              {
                key: "last",
                header: "Last active",
                render: (row) => {
                  const member = row.member as InfraUser;
                  return "lastLoginAt" in member && member.lastLoginAt
                    ? formatDate(String(member.lastLoginAt))
                    : "—";
                },
              },
              {
                key: "status",
                header: "Status",
                render: (row) => <StatusBadge status={(row.member as InfraUser).status} />,
              },
            ]}
            onRowClick={(row) => setSelected(row.member as InfraUser)}
          />
        )}
      </SectionCard>

      <CollapsibleBlock title="Role permissions" summary={`${roles.length} role templates`}>
        <div className="table-wrap">
          <table className="table compact">
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
        </div>
      </CollapsibleBlock>

      <Modal
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          setInviteResult(null);
        }}
        title="Invite user"
        description="Create an invitation link to share with a new team member."
        footer={
          <Button type="submit" form="invite-user-form" variant="primary" loading={busy}>
            Create invite
          </Button>
        }
      >
        <form id="invite-user-form" className="login-form" onSubmit={(e) => void onInvite(e)}>
          <label>
            Name
            <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} required />
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
        </form>
        <Notice tone="info">
          Invitation email is not sent automatically. Copy the setup link below and share it with
          the new user.
        </Notice>
        {inviteResult ? (
          inviteResult.startsWith("http") ? (
            <code className="mono small" style={{ wordBreak: "break-all", display: "block", marginTop: 12 }}>
              {inviteResult}
            </code>
          ) : (
            <p className="error-text">{inviteResult}</p>
          )
        ) : null}
      </Modal>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.displayName ?? "User"}
        footer={
          selected && canManage && selected.id !== user.userId ? (
            <Button type="button" variant="secondary" onClick={() => void toggleStatus(selected)}>
              {selected.status === "active" ? "Disable user" : "Reactivate user"}
            </Button>
          ) : null
        }
      >
        {selected && company ? (
          <>
            <KeyValue label="Email" value={selected.email} />
            <KeyValue
              label="Role"
              value={humanRole(
                selected.memberships.find((m) => m.companyId === company.id)?.role ?? "—",
              )}
            />
            <KeyValue label="Status" value={<StatusBadge status={selected.status} />} />
            <KeyValue
              label="Last active"
              value={
                "lastLoginAt" in selected && selected.lastLoginAt
                  ? formatDate(String(selected.lastLoginAt))
                  : "—"
              }
            />
            {roleDescription ? (
              <KeyValue label="Permissions" value={roleDescription} />
            ) : null}
          </>
        ) : null}
      </Drawer>
    </>
  );
}
