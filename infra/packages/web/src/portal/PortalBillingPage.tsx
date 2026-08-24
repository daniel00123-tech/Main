import { useEffect, useState } from "react";
import {
  PageHeader,
  SectionCard,
  formatCurrency,
  formatDate,
  ErrorState,
  LoadingState,
} from "../components";
import { api } from "../api";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalBillingPage() {
  const { company, loading, error } = usePortalCompany();
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof api.getWallet>> | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        setWallet(await api.getWallet(company.slug));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load wallet");
      }
    })();
  }, [company]);

  async function topUp(amountCents: number) {
    if (!company) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.createTopUp(company.slug, amountCents);
      if (result.mode === "pending_credentials" || !result.url) {
        setMessage(
          "Stripe is not configured yet. Ask the platform operator to set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Your top-up intent was recorded.",
        );
      } else if (typeof result.url === "string") {
        window.location.href = result.url;
      }
      setWallet(await api.getWallet(company.slug));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Top-up failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading || (!wallet && !loadError && !error)) return <LoadingState />;
  if (error || loadError || !company || !wallet) {
    return <ErrorState message={error ?? loadError ?? "Billing unavailable"} />;
  }

  return (
    <>
      <PageHeader
        title="Billing & Credits"
        subtitle="Prepaid credit wallet with ledger history. Stripe top-ups activate once secrets are configured."
      />

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card metric-card highlight-card">
          <h3>Available credit</h3>
          <div className="metric">
            {formatCurrency(wallet.wallet.balanceCents, wallet.wallet.currency)}
          </div>
          {wallet.wallet.lowBalance ? (
            <p className="warning-text">Below low-balance threshold</p>
          ) : (
            <p className="muted small">Ledger-backed balance</p>
          )}
        </div>
        <div className="card metric-card">
          <h3>Low-balance threshold</h3>
          <div className="metric">
            {formatCurrency(
              wallet.wallet.lowBalanceThresholdCents,
              wallet.wallet.currency,
            )}
          </div>
        </div>
        <div className="card metric-card">
          <h3>Stripe</h3>
          <div className="metric muted">
            {wallet.stripeConfigured ? "Configured" : "Not configured"}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Add credit">
          <p className="muted">
            Prepaid top-ups only — no subscription. Usage pricing is currently{" "}
            <strong>test configuration</strong> (not commercial rates).
          </p>
          <div className="topup-grid">
            {wallet.topUpOptionsCents.map((amount) => (
              <button
                key={amount}
                className="button topup-button"
                type="button"
                disabled={busy}
                onClick={() => void topUp(amount)}
              >
                {formatCurrency(amount)}
              </button>
            ))}
          </div>
          {message ? <p className="info-banner" style={{ marginTop: 16 }}>{message}</p> : null}
        </SectionCard>

        <SectionCard title="Recent transactions">
          {wallet.ledger.length === 0 ? (
            <p className="muted">No ledger entries yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Balance after</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {wallet.ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.entryType.replace(/_/g, " ")}</td>
                    <td>{formatCurrency(entry.amountCents)}</td>
                    <td>{formatCurrency(entry.balanceAfterCents)}</td>
                    <td>{formatDate(entry.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
      </div>
    </>
  );
}
