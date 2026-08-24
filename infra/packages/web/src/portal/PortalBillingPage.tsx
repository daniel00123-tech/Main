import { PageHeader, SectionCard } from "../components";
import { usePortalCompany } from "./usePortalCompany";
import { ErrorState, LoadingState } from "../components";

export default function PortalBillingPage() {
  const { company, overview, loading, error } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !overview) {
    return <ErrorState message={error ?? "Billing unavailable"} />;
  }

  return (
    <>
      <PageHeader
        title="Billing & Credits"
        subtitle="Wallet top-ups and customer charging are not configured yet."
      />

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Current balance</h3>
          <div className="metric muted">Not configured</div>
          <p className="muted small">Stripe and wallets come after usage metering is proven.</p>
        </div>
        <div className="card metric-card">
          <h3>Usage this month</h3>
          <div className="metric">
            {overview.usageSummary?.requestsThisMonth ?? 0} requests
          </div>
          <p className="muted small">Measured only — no customer charge applied.</p>
        </div>
        <div className="card metric-card">
          <h3>Auto top-up</h3>
          <div className="metric muted">Off</div>
          <p className="muted small">Future functionality</p>
        </div>
      </div>

      <SectionCard title="Future billing model">
        <p className="muted">
          Actual usage → underlying supplier/platform cost → INFRA customer price → margin →
          wallet debit. Stripe payments, top-ups, and credit enforcement are deferred until
          usage measurement is reliable.
        </p>
      </SectionCard>
    </>
  );
}
