import { EL_TEAM, EL_TENANT } from "./mock-data";
import { PageHeader, SectionCard, StatusBadge, formatDate } from "../components";

const ROLES = [
  { name: "Owner", desc: "Full company admin — billing, connectors, team, AI setup" },
  { name: "Administrator", desc: "Manage connectors and users, higher-risk actions" },
  { name: "Supervisor", desc: "Broader read access on team data" },
  { name: "Standard User", desc: "Search knowledge, read assigned jobs, limited notes" },
];

export default function PortalTeamPage() {
  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Manage who can access EL Business AI tools and what they can do."
      />

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header-row">
          <h3>Team members</h3>
          <button className="button button-primary" type="button">
            + Invite user
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>AI client</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {EL_TEAM.map((member) => (
              <tr key={member.id}>
                <td>
                  {member.name}
                  {member.id === EL_TENANT.loggedInUser.id ? (
                    <span className="muted"> (you)</span>
                  ) : null}
                </td>
                <td>{member.email}</td>
                <td>{member.role}</td>
                <td>
                  <StatusBadge value={member.status} />
                </td>
                <td>{member.aiClients.join(", ")}</td>
                <td>{formatDate(member.lastActive)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionCard title="Role permissions">
        <table className="table">
          <thead>
            <tr>
              <th>Role</th>
              <th>What they can do</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="muted">{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      <div className="card info-banner" style={{ marginTop: 24 }}>
        <strong>Example:</strong> Charlie Smith (Owner) invites John Smith as Standard User.
        John uses ChatGPT normally — INFRA enforces EL permissions server-side when he
        accesses company tools or knowledge.
      </div>
    </>
  );
}
