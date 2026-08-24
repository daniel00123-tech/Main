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
    return <ErrorState title="Unable to load billing" description={error ?? loadError ?? undefined} />;
  }

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your prepaid credit wallet. Top up when balance runs low."
      />

      {!wallet.stripeConfigured ? (
        <p className="info-banner" style={{ marginBottom: 16 }}>
          Card top-ups are unavailable until Stripe is configured by your platform administrator.
          Your current balance remains accurate.
        </p>
      ) : null}

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Available credit</h3>
          <div className="metric">
            {formatCurrency(wallet.wallet.balanceCents, wallet.wallet.currency)}
          </div>
          {wallet.wallet.lowBalance ? (
            <p className="warning-text">Low balance</p>
          ) : (
            <p className="muted small">Ready for usage</p>
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
          <h3>Payments</h3>
          <div className="metric" style={{ fontSize: "var(--text-lg)" }}>
            {wallet.stripeConfigured ? "Ready" : "Not configured"}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="Add credit">
          <p className="muted">Choose an amount to add to your wallet.</p>
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

        <SectionCard title="Transaction history">
          {wallet.ledger.length === 0 ? (
            <p className="muted">No transactions yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="num">Amount</th>
                  <th className="num">Balance</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {wallet.ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <strong>{humanLedgerType(entry.entryType)}</strong>
                      {entry.description ? (
                        <div className="muted small">{entry.description}</div>
                      ) : null}
                    </td>
                    <td className="num">
                      {formatCurrency(entry.amountCents, wallet.wallet.currency)}
                    </td>
                    <td className="num">
                      {formatCurrency(entry.balanceAfterCents, wallet.wallet.currency)}
                    </td>
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

function humanLedgerType(type: string): string {
  const map: Record<string, string> = {
    top_up: "Top up",
    credit: "Credit",
    usage: "Usage",
    debit: "Usage",
    refund: "Refund",
    adjustment: "Adjustment",
  };
  return map[type] ?? type.replace(/_/g, " ");
}
