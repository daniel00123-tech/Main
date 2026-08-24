import { MOCK_USERS } from "../mock-data";
import { PageHeader, SectionCard } from "../components";

const ROLES = [
  {
    name: "Standard User",
    permissions: "Search knowledge, read assigned jobs, add limited notes",
  },
  {
    name: "Supervisor",
    permissions: "Broader read on team data",
  },
  {
    name: "Administrator",
    permissions: "Connector management, user management, higher-risk actions",
  },
  {
    name: "Site Administrator",
    permissions: "Company-wide administration",
  },
  {
    name: "Platform Owner",
    permissions: "INFRA administration, billing, company setup",
  },
];

export default function UsersPermissionsPage() {
  return (
    <>
      <PageHeader
        title="Users & Permissions"
        subtitle="Permission foundations for MCP tools and connector actions. Enforced server-side."
      />

      <div className="grid grid-2">
        <SectionCard title="Users">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Companies</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_USERS.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{user.role}</td>
                  <td>{user.companies.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Role model">
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Typical permissions</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => (
                <tr key={role.name}>
                  <td>{role.name}</td>
                  <td className="muted">{role.permissions}</td>
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
