import { MOCK_BILLING } from "../mock-data";
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";

export default function BillingPage() {
  const b = MOCK_BILLING;
  const s = b.summary;

  return (
    <>
      <PageHeader
        title="Billing & Credits"
        subtitle="Prepaid credit model with immutable ledger. Stripe test mode for top-ups."
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Starting balance</h3>
          <div className="metric">{formatCurrency(b.startingBalanceCents)}</div>
        </div>
        <div className="card metric-card">
          <h3>Current balance</h3>
          <div className="metric">{formatCurrency(b.currentBalanceCents)}</div>
        </div>
        <div className="card metric-card">
          <h3>Total debits</h3>
          <div className="metric">{formatCurrency(s.totalDebitsCents)}</div>
        </div>
        <div className="card metric-card">
          <h3>Gross margin</h3>
          <div className="metric">{s.grossMarginPct.toFixed(1)}%</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 24 }}>
        <SectionCard title="Simulated billing — Caddington Holdings">
          <table className="table compact">
            <tbody>
              <tr>
                <td>Starting credit</td>
                <td>{formatCurrency(b.startingBalanceCents)}</td>
              </tr>
              <tr>
                <td>Total credits</td>
                <td>{formatCurrency(s.totalCreditsCents)}</td>
              </tr>
              <tr>
                <td>Total debits</td>
                <td>{formatCurrency(s.totalDebitsCents)}</td>
              </tr>
              <tr>
                <td>Ending balance</td>
                <td>{formatCurrency(b.currentBalanceCents)}</td>
              </tr>
              <tr>
                <td>Actual underlying cost</td>
                <td>{formatCurrency(s.totalActualCostCents)}</td>
              </tr>
              <tr>
                <td>Revenue (customer charges)</td>
                <td>{formatCurrency(s.totalRevenueCents)}</td>
              </tr>
              <tr>
                <td>Gross profit</td>
                <td>{formatCurrency(s.grossProfitCents)}</td>
              </tr>
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Stripe (test mode)">
          <p className="muted">
            Top-ups via Stripe Checkout. Webhook signature verification required
            before crediting accounts. Card data never stored in INFRA.
          </p>
          <button className="button" type="button" disabled>
            Top up £100 (test mode — prototype)
          </button>
        </SectionCard>
      </div>

      <SectionCard title="Transaction history (immutable ledger)">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Source</th>
              <th>Amount</th>
              <th>Actual cost</th>
              <th>Margin</th>
              <th>When</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {b.transactions.map((txn) => (
              <tr key={txn.id}>
                <td>
                  <StatusBadge
                    value={txn.type === "CREDIT" ? "active" : "syncing"}
                  />
                  {txn.type}
                </td>
                <td>{txn.source}</td>
                <td>{formatCurrency(txn.amountCents)}</td>
                <td>
                  {"actualCostCents" in txn && txn.actualCostCents != null
                    ? formatCurrency(txn.actualCostCents)
                    : "—"}
                </td>
                <td>
                  {"marginCents" in txn && txn.marginCents != null
                    ? formatCurrency(txn.marginCents)
                    : "—"}
                </td>
                <td>{formatDate(txn.at)}</td>
                <td>
                  <StatusBadge value={txn.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </>
  );
}
