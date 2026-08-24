import { EL_USAGE } from "./mock-data";
import { PageHeader, SectionCard, formatCurrency } from "../components";

export default function PortalUsagePage() {
  const u = EL_USAGE;

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="AI requests, connector operations, and knowledge searches — deducted from your credit balance."
      />

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>This month</h3>
          <div className="metric">{formatCurrency(u.thisMonthCents)}</div>
        </div>
        <div className="card metric-card">
          <h3>Knowledge searches</h3>
          <div className="metric">0</div>
        </div>
        <div className="card metric-card">
          <h3>AI requests</h3>
          <div className="metric">0</div>
        </div>
      </div>

      <SectionCard title="Usage events">
        {u.events.length === 0 ? (
          <div className="empty-state">
            <p>{u.message}</p>
            <p className="muted">
              When John Smith uses ChatGPT with EL tools, usage appears here with
              operation, user, charge, and request ID for audit.
            </p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>User</th>
                <th>Charge</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {u.events.map((e) => (
                <tr key={e.id}>
                  <td>{e.operation}</td>
                  <td>{e.user}</td>
                  <td>{formatCurrency(e.chargeCents)}</td>
                  <td>{e.at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </>
  );
}
