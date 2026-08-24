import { useEffect, useState } from "react";
import { api } from "../api";
import type { Company, InfraUser } from "@infra/shared";
import { ErrorState, LoadingState, PageHeader, SectionCard } from "../components";

export default function UsersPermissionsPage() {
  const [users, setUsers] = useState<InfraUser[]>([]);
  const [roles, setRoles] = useState<Awaited<ReturnType<typeof api.getRolePresets>>>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
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
        setError(err instanceof Error ? err.message : "Failed to load users");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  const companyById = new Map(companies.map((company) => [company.id, company.name]));

  return (
    <>
      <PageHeader
        title="Users & Permissions"
        subtitle="Identity, memberships, and role presets resolved into granular permissions server-side."
      />

      <div className="grid grid-2">
        <SectionCard title="Users">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Platform admin</th>
                <th>Companies</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.displayName}</td>
                  <td>{user.email}</td>
                  <td>{user.isPlatformAdmin ? "Yes" : "No"}</td>
                  <td>
                    {user.memberships.length
                      ? user.memberships
                          .map(
                            (membership) =>
                              `${companyById.get(membership.companyId) ?? membership.companyId} (${membership.role})`,
                          )
                          .join(", ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Company role presets">
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Description</th>
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
      </div>

      <SectionCard title="High-risk action safety">
        <p className="muted">
          High-risk actions (bulk updates, deletes, financial actions, external sends)
          can later require approval. The capability/risk model supports this without
          building a full approval engine in v0.1.
        </p>
      </SectionCard>
    </>
  );
}
