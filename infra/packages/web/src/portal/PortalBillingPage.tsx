import { EL_BILLING } from "./mock-data";
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";

export default function PortalBillingPage() {
  const b = EL_BILLING;

  return (
    <>
      <PageHeader
        title="Billing & Credits"
        subtitle="Prepaid credit for AI and connector usage. Top up securely via Stripe."
      />

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card metric-card highlight-card">
          <h3>Current balance</h3>
          <div className="metric">{formatCurrency(b.balanceCents, b.currency)}</div>
          {b.lowBalanceWarning ? (
            <p className="warning-text">Low balance — top up recommended</p>
          ) : (
            <p className="muted">Test credit active</p>
          )}
        </div>
        <div className="card metric-card">
          <h3>Usage this month</h3>
          <div className="metric">{formatCurrency(0)}</div>
        </div>
        <div className="card metric-card">
          <h3>Auto top-up</h3>
          <div className="metric muted">Off</div>
          <p className="muted small">Not available in v0.1</p>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Top up credits">
          <p className="muted">
            Pay via Stripe Checkout. Card details are handled by Stripe — never stored in INFRA.
          </p>
          <div className="topup-grid">
            {b.topUpOptions.map((amount) => (
              <button key={amount} className="button topup-button" type="button">
                {formatCurrency(amount)}
              </button>
            ))}
          </div>
          <button className="button button-primary" type="button" style={{ marginTop: 16 }}>
            Pay with Stripe (test mode)
          </button>
        </SectionCard>

        <SectionCard title="Transaction history">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Source</th>
                <th>Amount</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {b.transactions.map((txn) => (
                <tr key={txn.id}>
                  <td>
                    <StatusBadge value="active" />
                    {txn.type}
                  </td>
                  <td>{txn.source}</td>
                  <td>{formatCurrency(txn.amountCents)}</td>
                  <td>{formatDate(txn.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>
    </>
  );
}
