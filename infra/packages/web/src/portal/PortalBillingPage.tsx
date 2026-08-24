import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  formatCurrency,
  formatDate,
} from "../components";
import { api } from "../api";
import { humanLedgerType } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalBillingPage() {
  const { company, loading, error } = usePortalCompany();
  const [searchParams] = useSearchParams();
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof api.getWallet>> | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const topupState = searchParams.get("topup");

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
    if (!company || !wallet?.stripeConfigured) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.createTopUp(company.slug, amountCents);
      if (result.mode === "pending_credentials" || !result.url) {
        setMessage(
          "Card payments are not live yet. Your current balance is unchanged. Contact your administrator if you need credit added.",
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

  const totals = useMemo(() => {
    if (!wallet) return { credits: 0, charges: 0 };
    return {
      credits: wallet.ledger
        .filter((e) => e.amountCents > 0)
        .reduce((sum, e) => sum + e.amountCents, 0),
      charges: wallet.ledger
        .filter((e) => e.amountCents < 0)
        .reduce((sum, e) => sum + Math.abs(e.amountCents), 0),
    };
  }, [wallet]);

  if (loading || (!wallet && !loadError && !error)) {
    return <LoadingState label="Loading billing…" />;
  }
  if (error || loadError || !company || !wallet) {
    return (
      <ErrorState
        title="Unable to load billing"
        description={error ?? loadError ?? undefined}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Billing"
        description={`${company.name} · prepaid credit for AI usage`}
      />

      {!wallet.stripeConfigured ? (
        <Notice tone="warning">
          Card payments are not live. Your balance below is accurate. Ask a platform
          administrator if you need credit added.
        </Notice>
      ) : null}

      {topupState === "success" ? (
        <Notice tone="success">Payment received. Credit will appear once confirmed.</Notice>
      ) : null}
      {topupState === "cancelled" ? (
        <Notice tone="info">Top-up cancelled. No charge was made.</Notice>
      ) : null}

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Current balance</h3>
          <div className="metric">
            {formatCurrency(wallet.wallet.balanceCents, wallet.wallet.currency)}
          </div>
          {wallet.wallet.lowBalance ? (
            <p className="warning-text">Low balance — add credit soon</p>
          ) : (
            <p className="muted small">Available for AI usage</p>
          )}
        </div>
        <div className="card metric-card">
          <h3>Credits added</h3>
          <div className="metric">{formatCurrency(totals.credits, wallet.wallet.currency)}</div>
        </div>
        <div className="card metric-card">
          <h3>Usage charges</h3>
          <div className="metric">{formatCurrency(totals.charges, wallet.wallet.currency)}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard
          title="Add credit"
          description={
            wallet.stripeConfigured
              ? "Choose an amount. Card details are handled by Stripe — INFRA never stores them."
              : "Card top-up is prepared but not enabled."
          }
        >
          <div className="topup-grid">
            {wallet.topUpOptionsCents.map((amount) => (
              <button
                key={amount}
                className="button topup-button"
                type="button"
                disabled={busy || !wallet.stripeConfigured}
                onClick={() => void topUp(amount)}
              >
                {formatCurrency(amount)}
              </button>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: 12 }}>
            Planned amounts: £10, £25, £50, £100. Auto top-up (for example below £5 add £25)
            is not enabled yet.
          </p>
          {message ? <p className="info-banner" style={{ marginTop: 16 }}>{message}</p> : null}
        </SectionCard>

        <SectionCard title="Transaction history">
          {wallet.ledger.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              description="Credits and usage charges will appear here."
            />
          ) : (
            <div className="table-wrap">
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
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
