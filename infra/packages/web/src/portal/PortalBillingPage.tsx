import { useEffect, useState, useCallback } from "react";
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

type TopUpRecord = {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  creditedAt?: string | null;
  failureReason?: string | null;
};

export default function PortalBillingPage() {
  const { company, loading, error } = usePortalCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof api.getWallet>> | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingPayment, setConfirmingPayment] = useState(false);

  const topupState = searchParams.get("topup");
  const checkoutId = searchParams.get("checkout");

  const reloadWallet = useCallback(async () => {
    if (!company) return null;
    const data = await api.getWallet(company.slug);
    setWallet(data);
    return data;
  }, [company]);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        await reloadWallet();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load wallet");
      }
    })();
  }, [company, reloadWallet]);

  useEffect(() => {
    if (!company || topupState !== "success" || !checkoutId) {
      setConfirmingPayment(false);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    setConfirmingPayment(true);

    const poll = async () => {
      if (cancelled || attempts > 20) {
        setConfirmingPayment(false);
        return;
      }
      attempts += 1;
      try {
        const status = await api.getTopUpStatus(company.slug, checkoutId);
        if (status.checkout.status === "credited" || status.checkout.ledgerCredited) {
          setConfirmingPayment(false);
          await reloadWallet();
          return;
        }
      } catch {
        // keep polling
      }
      window.setTimeout(() => void poll(), 2000);
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [company, topupState, checkoutId, reloadWallet]);

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
        const localId = typeof result.localId === "string" ? result.localId : "";
        const returnUrl = new URL(window.location.href);
        returnUrl.searchParams.set("topup", "success");
        if (localId) returnUrl.searchParams.set("checkout", localId);
        window.location.href = result.url;
        return;
      }
      await reloadWallet();
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

  const stripeTestMode = wallet.paymentProvider?.testModeOnly ?? false;
  const recentTopUps = (wallet.recentTopUps ?? []) as TopUpRecord[];

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
      ) : stripeTestMode ? (
        <Notice tone="info">
          <strong>STRIPE TEST MODE</strong> — card payments use Stripe test credentials only.
          No real money is collected. Commercial live payments are not enabled.
        </Notice>
      ) : (
        <Notice tone="warning">
          Stripe is configured but not in test mode. Live commercial payments are blocked
          until operator approval.
        </Notice>
      )}

      {topupState === "success" ? (
        confirmingPayment ? (
          <Notice tone="info">
            Payment received by Stripe; confirming credit… Your balance updates once the
            webhook is processed (usually within a few seconds).
          </Notice>
        ) : (
          <Notice tone="success">
            Top-up complete. Your wallet balance reflects confirmed credit.
            <button
              type="button"
              className="button button-small button-secondary"
              style={{ marginLeft: 12 }}
              onClick={() => {
                searchParams.delete("topup");
                searchParams.delete("checkout");
                setSearchParams(searchParams);
              }}
            >
              Dismiss
            </button>
          </Notice>
        )
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
          <p className="muted small">Stripe top-ups (test or live once enabled)</p>
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard
          title="Add credit"
          description={
            wallet.stripeConfigured && stripeTestMode
              ? "Choose an amount. Card details are handled by Stripe Checkout — INFRA never stores card data."
              : wallet.stripeConfigured
                ? "Top-up buttons appear when Stripe test mode is active."
                : "Card top-up is prepared but not enabled."
          }
        >
          {wallet.stripeConfigured && stripeTestMode ? (
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
              Planned top-ups: £10, £25, £50, £100. Auto top-up (balance below £5 → add £25)
              is designed but not enabled — see ADR 015.
            </p>
          )}
          {message ? <p className="info-banner" style={{ marginTop: 16 }}>{message}</p> : null}
        </SectionCard>

        <SectionCard
          title="Recent top-ups"
          description="Payment status from server-side checkout records. Wallet credit is applied only after verified webhook."
        >
          {recentTopUps.length === 0 ? (
            <EmptyState
              title="No top-ups yet"
              description="Stripe checkout sessions will appear here."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTopUps.map((topUp) => (
                    <tr key={topUp.id}>
                      <td>{formatCurrency(topUp.amountCents, topUp.currency)}</td>
                      <td>
                        <strong>{topUp.status.replace(/_/g, " ")}</strong>
                        {topUp.failureReason ? (
                          <div className="muted small">{topUp.failureReason}</div>
                        ) : null}
                      </td>
                      <td>{formatDate(topUp.creditedAt ?? topUp.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

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
