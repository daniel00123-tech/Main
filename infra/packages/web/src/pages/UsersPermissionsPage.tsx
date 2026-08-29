import { useEffect, useMemo, useState } from "react";
import { Pencil, Trash2, Users } from "lucide-react";
import type { Company, CompanyRole, InfraUser } from "@infra/shared";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  Modal,
  PageHeader,
  SearchInput,
  SectionCard,
  StatusBadge,
  Tabs,
  toast,
  formatDate,
} from "../components";
import { formatRelativeTime, humanRole } from "../lib/format";

export default function UsersPermissionsPage() {
  const { companySlug: scopeCompanySlug } = useAdminScope();
  const [users, setUsers] = useState<InfraUser[]>([]);
  const [roles, setRoles] = useState<Awaited<ReturnType<typeof api.getRolePresets>>>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("users");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<InfraUser | null>(null);
  const [editUser, setEditUser] = useState<InfraUser | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editMobile, setEditMobile] = useState("");
  const [editRole, setEditRole] = useState<CompanyRole>("office_staff");
  const [editStatus, setEditStatus] = useState<"active" | "disabled">("active");
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleteUser, setDeleteUser] = useState<InfraUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCompany, setInviteCompany] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteMobile, setInviteMobile] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyRole>("office_staff");
  const [inviting, setInviting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [userList, rolePresets, companyList] = await Promise.all([
        api.getUsers(),
        api.getRolePresets(),
        api.getCompanies(),
      ]);
      setUsers(userList);
      setRoles(rolePresets);
      setCompanies(companyList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const companyById = useMemo(
    () => new Map(companies.map((c) => [c.id, c.name])),
    [companies],
  );

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = users;
    if (scopeCompanySlug) {
      const company = companies.find((c) => c.slug === scopeCompanySlug);
      if (company) {
        list = users.filter((u) =>
          u.memberships.some((m) => m.companyId === company.id),
        );
      }
    }
    if (!q) return list;
    return list.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    );
  }, [users, query, scopeCompanySlug, companies]);

  const roleUserCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of users) {
      for (const m of user.memberships) {
        counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
      }
    }
    return counts;
  }, [users]);

  if (loading) return <LoadingState label="Loading users…" />;
  if (error) {
    return <ErrorState title="Unable to load users" description={error} onRetry={() => void load()} />;
  }

  async function submitInvite() {
    if (!inviteCompany || !inviteEmail.trim() || !inviteName.trim() || !inviteMobile.trim()) {
      toast("Company, email, display name, and mobile number are required", "error");
      return;
    }
    setInviting(true);
    try {
      await api.inviteUser(inviteCompany, {
        email: inviteEmail.trim(),
        displayName: inviteName.trim(),
        role: inviteRole,
        mobile: inviteMobile.trim(),
      });
      toast(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteMobile("");
      setInviteName("");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to send invitation", "error");
    } finally {
      setInviting(false);
    }
  }

  function openEdit(user: InfraUser) {
    const primary = user.memberships[0];
    setEditUser(user);
    setEditName(user.displayName);
    setEditEmail(user.email);
    setEditMobile(user.mobileE164 ?? "");
    setEditRole((primary?.role as CompanyRole) ?? "office_staff");
    setEditStatus(user.status === "disabled" ? "disabled" : "active");
    setSelected(null);
  }

  async function submitEdit() {
    if (!editUser) return;
    if (!editName.trim() || !editEmail.trim()) {
      toast("Name and email are required", "error");
      return;
    }
    setSavingEdit(true);
    try {
      await api.updatePlatformUser(editUser.id, {
        displayName: editName.trim(),
        email: editEmail.trim(),
        mobile: editMobile.trim() || undefined,
        status: editStatus,
        companyId: editUser.memberships[0]?.companyId,
        role: editUser.memberships[0] ? editRole : undefined,
      });
      toast("User details saved");
      setEditUser(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to save user", "error");
    } finally {
      setSavingEdit(false);
    }
  }

  async function submitDelete() {
    if (!deleteUser) return;
    setDeleting(true);
    try {
      await api.deletePlatformUser(deleteUser.id);
      toast(`${deleteUser.displayName} has been disabled and invitations cancelled`);
      setDeleteUser(null);
      setSelected(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to delete user", "error");
    } finally {
      setDeleting(false);
    }
  }

  async function stopInviteEmails(user: InfraUser) {
    try {
      const result = await api.cancelPlatformUserInvitations(user.id);
      toast(
        result.cancelled
          ? "Pending invitation cancelled. No further setup emails will be sent."
          : "No pending invitation found. Setup links for this user are now invalid.",
      );
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to cancel invitation", "error");
    }
  }

  return (
    <>
      <PageHeader
        title="Users & Roles"
        description="People, roles, and permission presets across companies. AI Connections (ChatGPT/Claude) are company portal tokens; AI Gateways are the secure INFRA routing layer."
        actions={
          <Button type="button" variant="primary" onClick={() => setInviteOpen(true)}>
            + Add user
          </Button>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "users", label: "Users", count: users.length },
          { id: "roles", label: "Roles", count: roles.length },
          { id: "permissions", label: "Permissions" },
        ]}
      />

      {tab === "users" ? (
        <>
          <FilterBar>
            <SearchInput value={query} onChange={setQuery} placeholder="Search users…" className="grow" />
          </FilterBar>
          {filteredUsers.length === 0 ? (
            <EmptyState
              icon={<Users size={28} />}
              title="No users found"
              description="Invite people from a company portal."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Company</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Last active</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((user) => {
                    const primary = user.memberships[0];
                    return (
                      <tr
                        key={user.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => setSelected(user)}
                      >
                        <td>
                          <strong>{user.displayName}</strong>
                          <div className="muted small">{user.email}</div>
                        </td>
                        <td>
                          {primary
                            ? companyById.get(primary.companyId) ?? "—"
                            : user.isPlatformAdmin
                              ? "Platform"
                              : "—"}
                        </td>
                        <td>
                          {user.isPlatformAdmin
                            ? "Platform admin"
                            : humanRole(primary?.role)}
                        </td>
                        <td>
                          <StatusBadge status={user.status} />
                        </td>
                        <td className="muted">
                          {user.lastLoginAt
                            ? formatRelativeTime(user.lastLoginAt)
                            : "—"}
                        </td>
                        <td onClick={(event) => event.stopPropagation()}>
                          <div className="user-row-actions" style={{ justifyContent: "flex-end" }}>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => openEdit(user)}
                            >
                              <Pencil size={14} />
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setDeleteUser(user)}
                              disabled={user.isPlatformAdmin}
                              title={
                                user.isPlatformAdmin
                                  ? "Platform administrators cannot be deleted here"
                                  : "Disable this user and cancel invitation emails"
                              }
                            >
                              <Trash2 size={14} />
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {tab === "roles" ? (
        <div className="connector-grid">
          {roles.map((role) => (
            <article key={role.role} className="entity-card">
              <div className="connection-header">
                <h3>{role.displayName}</h3>
                <span className="muted small">
                  {roleUserCounts.get(role.role) ?? 0} users
                </span>
              </div>
              <p className="muted small">{role.description}</p>
              <div className="muted small" style={{ marginTop: 12 }}>
                {role.allowedActions.length} allowed · {role.deniedByDefault.length} denied by default
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {tab === "permissions" ? (
        <PermissionsEditor
          companies={companies}
          roles={roles}
          initialCompanySlug={scopeCompanySlug}
        />
      ) : null}

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite user"
        description="Send a secure email invitation. The user sets their own password via the activation link."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={inviting}
              onClick={() => void submitInvite()}
            >
              Send invitation
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <label>
            Company
            <select
              value={inviteCompany}
              onChange={(e) => setInviteCompany(e.target.value)}
              required
            >
              <option value="">Select company…</option>
              {companies.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
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
            Display name
            <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} required />
          </label>
          <label>
            Mobile number
            <input
              value={inviteMobile}
              onChange={(e) => setInviteMobile(e.target.value)}
              placeholder="+447700900123"
              required
            />
            <span className="muted small">International E.164 format, for example +447700900123</span>
          </label>
          <label>
            Role
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as CompanyRole)}>
              {roles.map((role) => (
                <option key={role.role} value={role.role}>
                  {role.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Modal>

      <Modal
        open={Boolean(editUser)}
        onClose={() => setEditUser(null)}
        title="Edit user"
        description="Update the details stored for this person. Saving does not send another email."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditUser(null)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" loading={savingEdit} onClick={() => void submitEdit()}>
              Save changes
            </Button>
          </>
        }
      >
        {editUser ? (
          <div className="form-grid">
            <label>
              Display name
              <input value={editName} onChange={(e) => setEditName(e.target.value)} required />
            </label>
            <label>
              Email
              <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required />
            </label>
            <label>
              Mobile number
              <input
                value={editMobile}
                onChange={(e) => setEditMobile(e.target.value)}
                placeholder="+447700900123"
              />
            </label>
            {editUser.memberships[0] ? (
              <label>
                Role
                <select value={editRole} onChange={(e) => setEditRole(e.target.value as CompanyRole)}>
                  {roles.map((role) => (
                    <option key={role.role} value={role.role}>
                      {role.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Status
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value as "active" | "disabled")}
              >
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(deleteUser)}
        onClose={() => setDeleteUser(null)}
        title="Delete user"
        description="This disables the account, removes company access, and cancels pending invitation emails. It does not delete historical audit records."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleteUser(null)}>
              Keep user
            </Button>
            <Button type="button" variant="danger" loading={deleting} onClick={() => void submitDelete()}>
              Delete user
            </Button>
          </>
        }
      >
        {deleteUser ? (
          <p>
            Disable <strong>{deleteUser.displayName}</strong> ({deleteUser.email})? They will no longer
            be able to sign in.
          </p>
        ) : null}
      </Modal>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.displayName ?? "User"}
        footer={
          selected ? (
            <div className="user-row-actions" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="secondary" onClick={() => void stopInviteEmails(selected)}>
                Stop invitation emails
              </Button>
              <Button type="button" variant="secondary" onClick={() => openEdit(selected)}>
                Edit
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => setDeleteUser(selected)}
                disabled={selected.isPlatformAdmin}
              >
                Delete
              </Button>
            </div>
          ) : undefined
        }
      >
        {selected ? (
          <>
            <div className="drawer-row">
              <dt>Email</dt>
              <dd>{selected.email}</dd>
            </div>
            <div className="drawer-row">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={selected.status} />
              </dd>
            </div>
            <div className="drawer-row">
              <dt>Platform admin</dt>
              <dd>{selected.isPlatformAdmin ? "Yes" : "No"}</dd>
            </div>
            <div className="drawer-row">
              <dt>Last active</dt>
              <dd>{selected.lastLoginAt ? formatDate(selected.lastLoginAt) : "—"}</dd>
            </div>
            <div className="drawer-row">
              <dt>Mobile</dt>
              <dd>
                {selected.mobileE164 ?? "Not set"}
                {selected.mobileVerificationRequired ? " · verification required" : ""}
                {selected.mobileVerified ? " · verified" : ""}
              </dd>
            </div>
            <h3 style={{ marginTop: 20, fontSize: "var(--text-md)" }}>Memberships</h3>
            {selected.memberships.length === 0 ? (
              <p className="muted">No company memberships.</p>
            ) : (
              selected.memberships.map((m) => (
                <div key={`${m.companyId}-${m.role}`} className="drawer-row">
                  <dt>{companyById.get(m.companyId) ?? m.companyId}</dt>
                  <dd>{humanRole(m.role)}</dd>
                </div>
              ))
            )}
          </>
        ) : null}
      </Drawer>
    </>
  );
}

function PermissionsEditor({
  companies,
  roles,
  initialCompanySlug,
}: {
  companies: Company[];
  roles: Awaited<ReturnType<typeof api.getRolePresets>>;
  initialCompanySlug?: string;
}) {
  const [companySlug, setCompanySlug] = useState(
    initialCompanySlug ?? companies[0]?.slug ?? "",
  );
  const [selectedRole, setSelectedRole] = useState<string>("engineer");
  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<
    Array<{ role: string; action: string; effect: "allow" | "deny" }>
  >([]);

  const editableRoles = roles.filter((r) => r.role !== "company_admin");

  useEffect(() => {
    if (initialCompanySlug) setCompanySlug(initialCompanySlug);
  }, [initialCompanySlug]);

  async function loadPermissions(slug: string) {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCompanyRolePermissions(slug);
      setOverrides(data.overrides);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load permissions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (companySlug) void loadPermissions(companySlug);
  }, [companySlug]);

  const rolePreset = roles.find((r) => r.role === selectedRole);

  useEffect(() => {
    if (!rolePreset) return;
    const map = new Map<string, boolean>();
    const allActions = [...rolePreset.allowedActions, ...rolePreset.deniedByDefault];
    for (const action of allActions) {
      const override = overrides.find((o) => o.role === selectedRole && o.action === action);
      if (override?.effect === "allow") map.set(action, true);
      else if (override?.effect === "deny") map.set(action, false);
      else map.set(action, rolePreset.allowedActions.includes(action));
    }
    setDraft(map);
  }, [rolePreset, overrides, selectedRole]);

  async function savePermissions() {
    if (!companySlug || !rolePreset) return;
    setSaving(true);
    setError(null);
    try {
      const grants: Array<{ action: string; effect: "allow" | "deny" }> = [];
      for (const [action, allowed] of draft.entries()) {
        const presetAllowed = (rolePreset.allowedActions as string[]).includes(action);
        if (allowed !== presetAllowed) {
          grants.push({ action, effect: allowed ? "allow" : "deny" });
        }
      }
      const result = await api.saveCompanyRolePermissions(companySlug, {
        role: rolePreset.role,
        grants,
      });
      setOverrides(result.overrides);
      toast("Permissions saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save permissions");
      toast(err instanceof Error ? err.message : "Unable to save permissions", "error");
    } finally {
      setSaving(false);
    }
  }

  if (!companies.length) {
    return (
      <EmptyState
        title="No companies"
        description="Create a company before editing role permissions."
      />
    );
  }

  const groups = rolePreset
    ? groupPermissions(rolePreset.allowedActions, rolePreset.deniedByDefault)
    : [];

  return (
    <SectionCard
      title="Permissions editor"
      description="Company-scoped role overrides. Defaults come from platform presets; changes apply only to the selected company. Company Admin presets are protected."
      actions={
        <Button type="button" variant="primary" loading={saving} onClick={() => void savePermissions()}>
          Save changes
        </Button>
      }
    >
      <div className="permissions-editor-controls">
        <label className="muted small">
          Company
          <select
            className="input"
            value={companySlug}
            onChange={(e) => setCompanySlug(e.target.value)}
          >
            {companies.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="muted small">
          Role
          <select
            className="input"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
          >
            {editableRoles.map((role) => (
              <option key={role.role} value={role.role}>
                {role.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? <LoadingState label="Loading permissions…" /> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!loading && rolePreset ? (
        <div className="permissions-editor">
          <div className="permissions-matrix-head">
            <span>Capability</span>
            <span>{rolePreset.displayName}</span>
          </div>
          {groups.map((group) => (
            <div key={group.id} className="permission-group">
              <h4 className="permission-group-title">{group.label}</h4>
              {group.items.map((item) => (
                <label key={item.action} className="permission-row">
                  <span>{item.label}</span>
                  <input
                    type="checkbox"
                    checked={draft.get(item.action) ?? item.allowed}
                    onChange={(e) => {
                      setDraft((prev) => {
                        const next = new Map(prev);
                        next.set(item.action, e.target.checked);
                        return next;
                      });
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
          <details className="advanced-block">
            <summary>Advanced — technical action strings</summary>
            <p className="mono small">{[...draft.entries()].filter(([, v]) => v).map(([a]) => a).join(", ")}</p>
          </details>
        </div>
      ) : null}
    </SectionCard>
  );
}

const PERMISSION_GROUP_DEFS: Array<{ id: string; label: string; prefix: string }> = [
  { id: "knowledge", label: "Knowledge", prefix: "knowledge." },
  { id: "finance", label: "Finance", prefix: "xero." },
  { id: "field", label: "Field service", prefix: "bigchange." },
  { id: "crm", label: "Customers", prefix: "commusoft." },
  { id: "admin", label: "Administration", prefix: "system." },
];

function groupPermissions(allowed: string[], denied: string[]) {
  const allowedSet = new Set(allowed);
  return PERMISSION_GROUP_DEFS.map((group) => ({
    ...group,
    items: [...allowed, ...denied]
      .filter((action) => action.startsWith(group.prefix))
      .map((action) => ({
        action,
        label: humaniseAction(action),
        allowed: allowedSet.has(action),
      })),
  })).filter((group) => group.items.length > 0);
}

function humaniseAction(action: string): string {
  return action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
