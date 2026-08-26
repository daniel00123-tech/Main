import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import type { Company, CompanyRole, InfraUser } from "@infra/shared";
import { api } from "../api";
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
  const [users, setUsers] = useState<InfraUser[]>([]);
  const [roles, setRoles] = useState<Awaited<ReturnType<typeof api.getRolePresets>>>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("users");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<InfraUser | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCompany, setInviteCompany] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyRole>("office_staff");
  const [inviting, setInviting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<string>("engineer");

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
    if (!q) return users;
    return users.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    );
  }, [users, query]);

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
    if (!inviteCompany || !inviteEmail.trim() || !inviteName.trim()) {
      toast("Company, email, and display name are required", "error");
      return;
    }
    setInviting(true);
    try {
      await api.inviteUser(inviteCompany, {
        email: inviteEmail.trim(),
        displayName: inviteName.trim(),
        role: inviteRole,
      });
      toast(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteName("");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to send invitation", "error");
    } finally {
      setInviting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Users & Roles"
        description="People, roles, and permission presets across companies. AI Connections (ChatGPT/Claude) are company portal tokens; AI Gateways are the secure INFRA routing layer."
        actions={
          <Button type="button" variant="primary" onClick={() => setInviteOpen(true)}>
            Invite user
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
        <SectionCard
          title="Permissions editor"
          description="Select a role to review grouped capabilities. Enforcement remains server-side; this reflects default role templates."
        >
          <div style={{ marginBottom: 16 }}>
            <label className="muted small">
              Role template
              <select
                className="input"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                style={{ display: "block", marginTop: 4, maxWidth: 320 }}
              >
                {roles.map((role) => (
                  <option key={role.role} value={role.role}>
                    {role.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(() => {
            const role = roles.find((r) => r.role === selectedRole);
            if (!role) return null;
            const groups = groupPermissions(role.allowedActions, role.deniedByDefault);
            return (
              <div className="permissions-editor">
                {groups.map((group) => (
                  <div key={group.id} className="permission-group">
                    <h4 className="permission-group-title">{group.label}</h4>
                    {group.items.map((item) => (
                      <label key={item.action} className="permission-row">
                        <input type="checkbox" checked={item.allowed} readOnly disabled />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
                <details className="advanced-block">
                  <summary>Advanced — technical action strings</summary>
                  <p className="mono small">{role.allowedActions.join(", ")}</p>
                </details>
              </div>
            );
          })()}
        </SectionCard>
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

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.displayName ?? "User"}>
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
