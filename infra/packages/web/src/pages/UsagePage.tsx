import { MOCK_USAGE } from "../mock-data";
import { PageHeader, StatusBadge, formatCurrency, formatDate } from "../components";

export default function UsagePage() {
  const totals = MOCK_USAGE.reduce(
    (acc, u) => ({
      actual: acc.actual + u.actualCostCents,
      charge: acc.charge + u.customerChargeCents,
      margin: acc.margin + u.marginCents,
    }),
    { actual: 0, charge: 0, margin: 0 },
  );

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Idempotent usage events. Retries must not cause double billing."
      />

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Actual cost</h3>
          <div className="metric">{formatCurrency(totals.actual)}</div>
        </div>
        <div className="card metric-card">
          <h3>Customer charge</h3>
          <div className="metric">{formatCurrency(totals.charge)}</div>
        </div>
        <div className="card metric-card">
          <h3>Gross margin</h3>
          <div className="metric">{formatCurrency(totals.margin)}</div>
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>When</th>
              <th>Operation</th>
              <th>Provider</th>
              <th>Tool</th>
              <th>Actual cost</th>
              <th>Charge</th>
              <th>Margin</th>
              <th>Request ID</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_USAGE.map((u) => (
              <tr key={u.id}>
                <td>{u.company}</td>
                <td>{formatDate(u.timestamp)}</td>
                <td>{u.operation}</td>
                <td>{u.provider}</td>
                <td>{u.tool}</td>
                <td>{formatCurrency(u.actualCostCents)}</td>
                <td>{formatCurrency(u.customerChargeCents)}</td>
                <td>{formatCurrency(u.marginCents)}</td>
                <td className="mono">{u.requestId}</td>
                <td>
                  <StatusBadge value={u.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
