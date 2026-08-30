import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, UserPlus, Users } from "lucide-react";
import { api } from "../api";
import type { CompanyRole, InfraUser } from "@infra/shared";
import {
  Button,
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
  Tabs,
  formatDate,
  useIsMobile,
} from "../components";
import { ActionMenuPopover } from "../components/ActionMenuPopover";
import { PermissionsEditor } from "../components/PermissionsEditor";
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
  const [actionMenuUserId, setActionMenuUserId] = useState<string | null>(null);
  const actionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [resetTarget, setResetTarget] = useState<InfraUser | null>(null);
  const [tempPassword, setTempPassword] = useState("");
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [tab, setTab] = useState("users");
  const [invitations, setInvitations] = useState<Array<Record<string, unknown>>>([]);
  const [elvexRbac, setElvexRbac] = useState<Awaited<ReturnType<typeof api.getElvexRbac>> | null>(null);
  const isMobile = useIsMobile();

  const isElvex = company?.slug === "el-business" || company?.id === "co_el";
  const canManage =
    user?.isPlatformAdmin ||
    membership?.role === "company_admin" ||
    membership?.role === "director";
  const canManageRoles = Boolean(user?.isPlatformAdmin || membership?.role === "company_admin");

  async function refresh() {
    if (!company) return;
    const [users, rolePresets, inviteList] = await Promise.all([
      api.getUsers(company.id),
      api.getRolePresets(isElvex ? "el-business" : undefined),
      canManage ? api.getInvitations(company.slug).catch(() => ({ invitations: [] })) : Promise.resolve({ invitations: [] }),
    ]);
    setTeam(users);
    setRoles(rolePresets);
    setInvitations(inviteList.invitations);
    if (isElvex && canManage) {
      setElvexRbac(await api.getElvexRbac(company.slug).catch(() => null));
    }
  }

  useEffect(() => {
    if (!actionMenuUserId) return;
    const close = () => setActionMenuUserId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [actionMenuUserId]);

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
  const actionMenuMember = useMemo(
    () => (actionMenuUserId ? team.find((member) => member.id === actionMenuUserId) ?? null : null),
    [actionMenuUserId, team],
  );

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
        result.emailSent
          ? `Invitation email sent to ${inviteEmail}`
          : result.setupUrl ?? "Invitation created",
      );
      setInviteEmail("");
      setInviteName("");
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invite failed";
      if (message.includes("DUPLICATE_ACTIVE_INVITATION") || message.includes("already exists")) {
        setInviteResult(
          "An active invitation already exists for this email. Use Resend on the existing row or cancel it first.",
        );
      } else {
        setInviteResult(message);
      }
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

  function isLastCompanyAdmin(member: InfraUser): boolean {
    if (!company) return false;
    const memberRole = member.memberships.find((m) => m.companyId === company.id)?.role;
    if (memberRole !== "company_admin" || member.status !== "active") return false;
    const activeAdmins = team.filter((m) => {
      const role = m.memberships.find((item) => item.companyId === company.id)?.role;
      return m.status === "active" && role === "company_admin";
    });
    return activeAdmins.length <= 1;
  }

  function canManageMember(member: InfraUser): boolean {
    return Boolean(canManage && member.id !== user?.userId && !member.isPlatformAdmin);
  }

  async function resetPassword(member: InfraUser, options?: { temporaryPassword?: string }) {
    if (!company) return;
    setBusy(true);
    setResetResult(null);
    try {
      const result = await api.resetCompanyUserPassword(company.slug, member.id, options);
      const link = result.resetUrl ?? result.setupUrl ?? "";
      setResetResult(
        link
          ? `${result.message}\n\n${link}`
          : result.message,
      );
      await refresh();
    } catch (err) {
      setResetResult(err instanceof Error ? err.message : "Unable to reset password");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: InfraUser) {
    if (!company) return;
    if (
      !window.confirm(
        `Remove ${member.displayName} from ${company.name}? They will lose access to this company portal.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.removeCompanyUser(company.slug, member.id);
      setActionMenuUserId(null);
      setSelected(null);
      await refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Unable to remove user");
    } finally {
      setBusy(false);
    }
  }

  function renderUserActions(member: InfraUser) {
    if (!canManageMember(member)) return null;
    const menuOpen = actionMenuUserId === member.id;

    return (
      <div className="user-row-actions">
        <button
          type="button"
          className="button button-ghost button-small user-row-actions-trigger"
          aria-label={`Actions for ${member.displayName}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            if (menuOpen) {
              closeActionMenu();
              return;
            }
            actionMenuTriggerRef.current = e.currentTarget;
            setActionMenuUserId(member.id);
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
    );
  }

  function closeActionMenu() {
    setActionMenuUserId(null);
    actionMenuTriggerRef.current = null;
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
          (isElvex ? canManageRoles : canManage) ? (
            <Button type="button" variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus size={16} style={{ marginRight: 6 }} aria-hidden />
              Invite user
            </Button>
          ) : null
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "users", label: "Users", count: team.length },
          ...(canManage
            ? [
                { id: "permissions", label: "Permissions" },
                { id: "invitations", label: "Invitations", count: invitations.length },
                ...(isElvex
                  ? [
                      { id: "roles", label: "Roles" },
                      { id: "knowledge", label: "Knowledge" },
                      { id: "protected", label: "Protected users" },
                    ]
                  : []),
              ]
            : []),
        ]}
      />

      {tab === "users" ? (
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
                  if (canManageRoles && member.id !== user.userId) {
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
              ...(canManage
                ? [
                    {
                      key: "actions",
                      header: "",
                      render: (row: Record<string, unknown>) =>
                        renderUserActions(row.member as InfraUser),
                    },
                  ]
                : []),
            ]}
            onRowClick={(row) => setSelected(row.member as InfraUser)}
          />
        )}
      </SectionCard>
      ) : null}

      {tab === "permissions" && canManage ? (
        <PermissionsEditor companySlug={company.slug} roles={roles} />
      ) : null}

      {tab === "roles" && canManage && elvexRbac ? (
        <SectionCard title="Canonical Elvex roles">
          <p className="muted small">{elvexRbac.identityLimitation}</p>
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Read</th>
                  <th>Write / manage</th>
                </tr>
              </thead>
              <tbody>
                {elvexRbac.roles.map((item) => (
                  <tr key={item.role}>
                    <td>{item.label}</td>
                    <td className="small">
                      {item.capabilities.filter((c) => c.access === "read").map((c) => c.capability).join(", ") || "—"}
                    </td>
                    <td className="small">
                      {item.capabilities.filter((c) => c.access === "write").map((c) => c.capability).join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      {tab === "knowledge" && canManage && elvexRbac ? (
        <SectionCard title="Knowledge classification">
          <p className="muted small">
            Explicit and directory classification override automated keyword flags. Restricted management is
            director and Company Admin only. Finance is not restricted management.
          </p>
          <ul style={{ marginTop: 12 }}>
            {elvexRbac.classifications.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong> <span className="muted">({item.id})</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {tab === "protected" && canManage && elvexRbac ? (
        <SectionCard title="Protected Microsoft users">
          <p className="muted small">
            Owner-level deny remains in force. RBAC cannot grant access to these drives. Secrets are not shown.
          </p>
          <ul style={{ marginTop: 12 }}>
            {elvexRbac.protectedMicrosoftUsers.map((item) => (
              <li key={item.hint}>
                {item.label} <span className="muted">hint: {item.hint}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {tab === "invitations" && canManage ? (
        <SectionCard title="Pending invitations">
          {invitations.length === 0 ? (
            <EmptyState title="No pending invitations" description="Invited users will appear here until they accept." />
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((inv) => (
                    <tr key={String(inv.id)}>
                      <td>{String(inv.email)}</td>
                      <td>{humanRole(String(inv.role))}</td>
                      <td>
                        <StatusBadge status={String(inv.status)} />
                      </td>
                      <td className="muted small">{formatDate(String(inv.expiresAt))}</td>
                      <td>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {inv.status === "pending" || inv.status === "expired" ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={async () => {
                                const r = await api.resendInvitation(company.slug, String(inv.id));
                                window.alert(
                                  r.emailSent ? "Invitation resent by email" : `Copy link: ${r.setupUrl}`,
                                );
                                await refresh();
                              }}
                            >
                              Resend
                            </Button>
                          ) : null}
                          {inv.status === "pending" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={async () => {
                                await api.cancelInvitation(company.slug, String(inv.id));
                                await refresh();
                              }}
                            >
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      ) : null}

      {/* legacy read-only role summary removed — use Permissions tab */}

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
          selected && canManageMember(selected) ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setResetTarget(selected);
                  setTempPassword("");
                  setResetResult(null);
                }}
              >
                Reset password
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={isLastCompanyAdmin(selected)}
                onClick={() => void toggleStatus(selected)}
              >
                {selected.status === "active" ? "Disable access" : "Enable access"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={isLastCompanyAdmin(selected)}
                onClick={() => void removeMember(selected)}
              >
                Remove user
              </Button>
            </div>
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

      <Modal
        open={Boolean(resetTarget)}
        onClose={() => {
          setResetTarget(null);
          setTempPassword("");
          setResetResult(null);
        }}
        title="Reset password"
        description={
          resetTarget
            ? `Create a secure reset link or set a temporary password for ${resetTarget.displayName}.`
            : undefined
        }
        footer={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              type="button"
              variant="secondary"
              loading={busy}
              onClick={() => resetTarget && void resetPassword(resetTarget)}
            >
              Send reset link
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={!tempPassword || tempPassword.length < 12}
              onClick={() =>
                resetTarget &&
                void resetPassword(resetTarget, { temporaryPassword: tempPassword })
              }
            >
              Set temporary password
            </Button>
          </div>
        }
      >
        <label className="field">
          <span className="field-label">Temporary password (optional)</span>
          <input
            className="input"
            type="password"
            value={tempPassword}
            onChange={(e) => setTempPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            placeholder="Minimum 12 characters"
          />
        </label>
        <p className="muted small">
          Passwords are hashed immediately and never shown again. Share a reset link or temporary
          password securely with the user.
        </p>
        {resetResult ? (
          <code className="mono small" style={{ wordBreak: "break-all", display: "block", marginTop: 12 }}>
            {resetResult}
          </code>
        ) : null}
      </Modal>

      {actionMenuMember ? (
        <ActionMenuPopover
          open
          triggerRef={actionMenuTriggerRef}
          onClose={closeActionMenu}
          ariaLabel={`Actions for ${actionMenuMember.displayName}`}
          items={[
            {
              label: "Reset password",
              onSelect: () => {
                setResetTarget(actionMenuMember);
                setTempPassword("");
                setResetResult(null);
              },
            },
            {
              label:
                actionMenuMember.status === "active" ? "Disable access" : "Enable access",
              disabled: isLastCompanyAdmin(actionMenuMember),
              title: isLastCompanyAdmin(actionMenuMember)
                ? "Cannot disable the last company administrator"
                : undefined,
              onSelect: () => void toggleStatus(actionMenuMember),
            },
            {
              label: "Remove user",
              danger: true,
              disabled: isLastCompanyAdmin(actionMenuMember),
              title: isLastCompanyAdmin(actionMenuMember)
                ? "Cannot remove the last company administrator"
                : undefined,
              onSelect: () => void removeMember(actionMenuMember),
            },
          ]}
        />
      ) : null}
    </>
  );
}
