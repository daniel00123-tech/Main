import { useEffect, useState } from "react";
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
          Online payments not configured. Stripe is prepared but not live. Tide is the
          payout bank account only — there is no Tide API in this product.
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
          <h3>TEST credit</h3>
          <div className="metric">
            {formatCurrency(wallet.wallet.testCreditCents ?? 0, wallet.wallet.currency)}
          </div>
          <p className="muted small">Promotional / opening TEST credit</p>
        </div>
        <div className="card metric-card">
          <h3>Paid credit</h3>
          <div className="metric">
            {formatCurrency(wallet.wallet.paidCreditCents ?? 0, wallet.wallet.currency)}
          </div>
          <p className="muted small">Stripe top-ups once payments are live</p>
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
          {wallet.stripeConfigured ? (
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
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Planned top-ups: £10, £25, £50, £100, plus custom. Auto top-up (balance below
              £5 → add £25) is designed but not enabled.
            </p>
          )}
          {message ? <p className="info-banner" style={{ marginTop: 16 }}>{message}</p> : null}
        </SectionCard>

        <SectionCard
          title="Charges"
          description="Grouped only when several actions belong to the same request. The ledger below remains the source of truth."
        >
          {(wallet.chargeGroups ?? []).length === 0 && wallet.ledger.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              description="Credits and usage charges will appear here."
            />
          ) : (
            <div className="interaction-list">
              {(wallet.chargeGroups ?? []).map((group) => (
                <details key={group.id} className="interaction-card" open={group.kind === "entry"}>
                  <summary className="interaction-summary">
                    <div>
                      <div className="interaction-when">{formatDate(group.createdAt)}</div>
                      <div className="muted small">
                        {group.kind === "interaction"
                          ? `${group.entries.length} operations`
                          : humanLedgerType(
                              wallet.ledger.find((e) => e.id === group.entries[0]?.id)?.entryType ??
                                "usage_debit",
                            )}
                      </div>
                    </div>
                    <div className="interaction-main">
                      <strong>{group.label}</strong>
                    </div>
                    <div className="num interaction-charge">
                      {formatCurrency(group.amountCents, wallet.wallet.currency)}
                    </div>
                  </summary>
                  {group.entries.length > 1 ? (
                    <div className="interaction-body">
                      {group.entries.map((entry) => (
                        <div key={entry.id} className="ledger-child">
                          <span>{entry.description ?? "Usage charge"}</span>
                          <span className="num">
                            {formatCurrency(entry.amountCents, wallet.wallet.currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </details>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Ledger"
        description="Every wallet change is listed here. A 2p request still shows as two 1p lines."
      >
        {wallet.ledger.length === 0 ? (
          <EmptyState
            title="No ledger entries yet"
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
    </>
  );
}
