import { EL_DASHBOARD, EL_TENANT } from "./mock-data";
import { PageHeader, SectionCard, StatusBadge, formatCurrency } from "../components";

export default function PortalDashboardPage() {
  const d = EL_DASHBOARD;

  return (
    <>
      <PageHeader
        title={`Welcome, ${EL_TENANT.loggedInUser.name.split(" ")[0]}`}
        subtitle={`${EL_TENANT.company.name} — your company AI infrastructure`}
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Credit balance</h3>
          <div className="metric">{formatCurrency(d.creditBalanceCents)}</div>
        </div>
        <div className="card metric-card">
          <h3>Usage this month</h3>
          <div className="metric">{formatCurrency(d.usageThisMonthCents)}</div>
        </div>
        <div className="card metric-card">
          <h3>Connectors</h3>
          <div className="metric">
            {d.connectorsConnected}/{d.connectorsTotal}
          </div>
        </div>
        <div className="card metric-card">
          <h3>MCP status</h3>
          <StatusBadge value={d.mcpStatus} />
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Setup progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${d.setupProgress}%` }} />
          </div>
          <p className="muted">{d.setupProgress}% complete</p>
          <ul className="checklist">
            {d.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Your connections">
          <table className="table">
            <tbody>
              <tr>
                <td>BigChange</td>
                <td>
                  <StatusBadge value="draft" /> Not connected
                </td>
              </tr>
              <tr>
                <td>SharePoint</td>
                <td>
                  <StatusBadge value="draft" /> Not connected
                </td>
              </tr>
              <tr>
                <td>ChatGPT</td>
                <td>
                  <StatusBadge value="registered" /> Planned
                </td>
              </tr>
              <tr>
                <td>Team members</td>
                <td>{d.teamMembers}</td>
              </tr>
            </tbody>
          </table>
        </SectionCard>
      </div>

      <div className="card info-banner" style={{ marginTop: 24 }}>
        <strong>v0.1:</strong> Charlie (Owner) manages EL here. Developer setup for BigChange
        happens in the background — this dashboard updates when INFRA registers the connection.
        Self-service &quot;Connect now&quot; comes in v0.2.
      </div>
    </>
  );
}
