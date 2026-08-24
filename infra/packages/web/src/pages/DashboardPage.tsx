import { Link } from "react-router-dom";
import { MOCK_DASHBOARD, MOCK_COMPANIES } from "../mock-data";
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";

export default function DashboardPage() {
  const d = MOCK_DASHBOARD;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Operational overview across companies, connectors, MCP health, credits, and sync status."
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Companies</h3>
          <div className="metric">{d.companies}</div>
        </div>
        <div className="card metric-card">
          <h3>Active Connectors</h3>
          <div className="metric">{d.activeConnectors}</div>
        </div>
        <div className="card metric-card">
          <h3>MCP Health</h3>
          <div className="metric">
            {d.mcpHealthy}/{d.mcpTotal}
          </div>
        </div>
        <div className="card metric-card">
          <h3>Total Credits</h3>
          <div className="metric">{formatCurrency(d.totalCreditCents)}</div>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Usage Today</h3>
          <div className="metric">{formatCurrency(d.usageTodayCents)}</div>
        </div>
        <div className="card metric-card">
          <h3>Warnings</h3>
          <div className="metric warning-text">{d.warnings}</div>
        </div>
        <div className="card metric-card">
          <h3>Errors</h3>
          <div className="metric">{d.errors}</div>
        </div>
        <div className="card metric-card">
          <h3>Connector Failures</h3>
          <div className="metric">0</div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Companies">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>MCP</th>
                <th>Credit</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_COMPANIES.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/companies/${c.slug}`}>{c.name}</Link>
                  </td>
                  <td>
                    <StatusBadge value={c.status} />
                  </td>
                  <td>
                    <StatusBadge value={c.mcpStatus} />
                  </td>
                  <td>{formatCurrency(c.creditBalanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Warnings">
          {d.warningsList.map((w, i) => (
            <div key={i} className="warning-item">
              <StatusBadge value="degraded" />
              <span>{w.message}</span>
            </div>
          ))}
        </SectionCard>

        <SectionCard title="Latest Syncs">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Connector</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {d.latestSyncs.map((s, i) => (
                <tr key={i}>
                  <td>{s.company}</td>
                  <td>{s.connector}</td>
                  <td>
                    <StatusBadge value={s.status} />
                  </td>
                  <td>{s.at ? formatDate(s.at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Architecture">
          <p className="muted">
            Company cloud systems → INFRA connector → automatic sync/index →
            company MCP → ChatGPT / Claude / future channels
          </p>
          <p className="muted">
            Business systems remain authoritative. INFRA is the control plane only.
          </p>
        </SectionCard>
      </div>
    </>
  );
}
