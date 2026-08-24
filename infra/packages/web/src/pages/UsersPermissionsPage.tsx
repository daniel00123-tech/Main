import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import type { Company, InfraUser } from "@infra/shared";
import { api } from "../api";
import {
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  SearchInput,
  SectionCard,
  StatusBadge,
  Tabs,
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

  return (
    <>
      <PageHeader
        title="Users & Roles"
        description="People, roles, and permission presets across companies."
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
          title="Permission model"
          description="Company admins see human capability labels. Technical action strings stay in Advanced."
        >
          <div className="stack">
            {roles.slice(0, 3).map((role) => (
              <details key={role.role} className="advanced-block" style={{ marginTop: 0 }}>
                <summary>
                  {role.displayName} — can / cannot
                </summary>
                <div className="grid grid-2" style={{ marginTop: 12 }}>
                  <div>
                    <strong className="small">Can</strong>
                    <ul className="muted small">
                      {role.allowedActions.slice(0, 8).map((a) => (
                        <li key={a}>{humaniseAction(a)}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong className="small">Cannot (by default)</strong>
                    <ul className="muted small">
                      {role.deniedByDefault.slice(0, 8).map((a) => (
                        <li key={a}>{humaniseAction(a)}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <details className="advanced-block">
                  <summary>Technical permissions</summary>
                  <p className="mono small">{role.allowedActions.join(", ")}</p>
                </details>
              </details>
            ))}
          </div>
        </SectionCard>
      ) : null}

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

function humaniseAction(action: string): string {
  return action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
