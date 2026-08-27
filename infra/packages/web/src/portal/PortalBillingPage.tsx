import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  KpiStrip,
  KeyValue,
  LoadingState,
  Notice,
  SectionCard,
  Tabs,
  formatCurrency,
  formatDate,
} from "../components";
import { api } from "../api";
import { humanLedgerType } from "../lib/format";
import { PortalPageHeader, ProductCard } from "./components";
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

type BillingTab = "overview" | "payment" | "auto-topup" | "transactions" | "invoices" | "addons";

const ADDON_PRODUCTS = [
  {
    name: "Priority data refresh",
    benefit: "Faster knowledge and connector sync cycles for time-sensitive operations.",
    price: "Pricing TBC",
  },
  {
    name: "Enhanced analytics",
    benefit: "Deeper usage insights and exportable reports for finance and operations teams.",
    price: "Pricing TBC",
  },
  {
    name: "Additional knowledge capacity",
    benefit: "Expanded document indexing limits for larger company knowledge bases.",
    price: "Pricing TBC",
  },
  {
    name: "Premium support",
    benefit: "Priority response for connector, billing, and AI connection issues.",
    price: "Pricing TBC",
  },
];

export default function PortalBillingPage() {
  const { company, loading, error } = usePortalCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof api.getWallet>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingPayment, setConfirmingPayment] = useState(false);
  const [tab, setTab] = useState<BillingTab>("overview");
  const [customAmount, setCustomAmount] = useState("");
  const [ledgerLimit, setLedgerLimit] = useState(30);
  const [paymentMethod, setPaymentMethod] = useState<Awaited<
    ReturnType<typeof api.getPaymentMethod>
  >["paymentMethod"] | null>(null);
  const [autoTopUpThreshold, setAutoTopUpThreshold] = useState("10");
  const [autoTopUpAmount, setAutoTopUpAmount] = useState("25");
  const [autoTopUpConfirm, setAutoTopUpConfirm] = useState(false);

  const topupState = searchParams.get("topup");
  const checkoutId = searchParams.get("checkout");
  const tabParam = searchParams.get("tab");

  useEffect(() => {
    if (tabParam === "payment" || tabParam === "auto-topup" || tabParam === "overview") {
      setTab(tabParam as BillingTab);
    }
  }, [tabParam]);

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
        if (tab === "payment" || searchParams.get("setup") === "complete") {
          const pm = await api.getPaymentMethod(company.slug);
          setPaymentMethod(pm.paymentMethod);
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load wallet");
      }
    })();
  }, [company, reloadWallet, tab, searchParams]);

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
        /* keep polling */
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
          "Card payments are not live yet. Your balance is unchanged. Contact your administrator if you need credit added.",
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
      <ErrorState title="Unable to load billing" description={error ?? loadError ?? undefined} />
    );
  }

  const stripeTestMode = wallet.paymentProvider?.testModeOnly ?? false;
  const recentTopUps = (wallet.recentTopUps ?? []) as TopUpRecord[];
  const topUpOptions = wallet.topUpOptionsCents.filter((amount) => amount >= 1000);
  const autoTopUp = wallet.paymentProvider?.autoTopUp;
  const spendThisMonth =
    wallet.wallet.spendThisMonthCents ??
    wallet.billing?.spendThisMonthCents ??
    0;
  const walletHealth = wallet.wallet.walletHealthState ?? (wallet.wallet.lowBalance ? "low" : "healthy");

  async function startPaymentMethodSetup() {
    if (!company) return;
    setBusy(true);
    try {
      const result = await api.startPaymentMethodSetup(company.slug);
      if (result.url) window.location.href = result.url;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to start payment setup");
    } finally {
      setBusy(false);
    }
  }

  async function saveAutoTopUp(enabled: boolean) {
    if (!company) return;
    if (enabled && !autoTopUpConfirm) {
      setMessage("Please confirm you understand auto top-up will charge your saved card.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.updateAutoTopUp(company.slug, {
        enabled,
        thresholdCents: Math.round(Number(autoTopUpThreshold) * 100) || 1000,
        amountCents: Math.round(Number(autoTopUpAmount) * 100) || 2500,
        confirm: enabled,
      });
      await reloadWallet();
      setMessage(enabled ? "Auto top-up configuration saved." : "Auto top-up disabled.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save auto top-up settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PortalPageHeader
        title="Billing"
        description={`Prepaid credit for AI usage · ${company.name}`}
      />

      {!wallet.stripeConfigured ? (
        <Notice tone="warning">
          Online payments are not configured yet. Contact your administrator to add credit manually.
        </Notice>
      ) : stripeTestMode ? (
        <Notice tone="info">
          <strong>Test mode</strong> — card payments use Stripe test credentials only. No real
          money is collected.
        </Notice>
      ) : null}

      {topupState === "success" ? (
        confirmingPayment ? (
          <Notice tone="info">Payment received — confirming credit…</Notice>
        ) : (
          <Notice tone="success">
            Top-up complete.
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

      <Tabs
        active={tab}
        onChange={(id) => setTab(id as BillingTab)}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "payment", label: "Payment method" },
          { id: "auto-topup", label: "Auto top-up" },
          { id: "transactions", label: "Transactions" },
          { id: "invoices", label: "Invoices" },
          { id: "addons", label: "Add-ons" },
        ]}
      />

      {tab === "overview" ? (
        <div className="billing-tab-panel">
          <KpiStrip
            items={[
              {
                label: "Current balance",
                value: formatCurrency(wallet.wallet.balanceCents, wallet.wallet.currency),
                hint:
                  walletHealth === "healthy"
                    ? "Available for AI usage"
                    : walletHealth === "empty"
                      ? "Empty — add credit"
                      : "Low balance — add credit",
              },
              {
                label: "Promotional credit",
                value: formatCurrency(wallet.wallet.testCreditCents ?? 0, wallet.wallet.currency),
                hint: "Non-paid trial or promotional balance",
              },
              {
                label: "Spend this month",
                value: formatCurrency(spendThisMonth, wallet.wallet.currency),
                hint: "Usage charges this month",
              },
              {
                label: "Paid credit",
                value: formatCurrency(wallet.wallet.paidCreditCents ?? 0, wallet.wallet.currency),
                hint: "From Stripe top-ups",
              },
              {
                label: "Auto top-up",
                value: autoTopUp?.enabled ? "On" : "Off",
                hint: autoTopUp?.enabled
                  ? `Below ${formatCurrency(autoTopUp.thresholdCents ?? 0)} → add ${formatCurrency(autoTopUp.amountCents ?? 0)}`
                  : "Not enabled yet",
              },
            ]}
          />

          <SectionCard title="Add credit" description="Card details are handled securely by Stripe Checkout.">
            {wallet.stripeConfigured && stripeTestMode ? (
              <>
                <div className="topup-grid-compact">
                  {topUpOptions.map((amount) => (
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
                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <Input
                    type="number"
                    min={10}
                    step={1}
                    placeholder="Custom £"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    style={{ maxWidth: 120 }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy || !customAmount}
                    onClick={() => {
                      const pounds = Number(customAmount);
                      if (Number.isFinite(pounds) && pounds >= 10) void topUp(Math.round(pounds * 100));
                    }}
                  >
                    Top up custom amount
                  </Button>
                </div>
              </>
            ) : (
              <p className="muted">Top-up is available when Stripe test mode is active.</p>
            )}
            {message ? <p className="info-banner" style={{ marginTop: 16 }}>{message}</p> : null}
          </SectionCard>

          {recentTopUps.length > 0 ? (
            <SectionCard title="Recent top-ups">
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTopUps.slice(0, 5).map((topUp) => (
                      <tr key={topUp.id}>
                        <td>{formatCurrency(topUp.amountCents, topUp.currency)}</td>
                        <td>{topUp.status.replace(/_/g, " ")}</td>
                        <td>{formatDate(topUp.creditedAt ?? topUp.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {tab === "payment" ? (
        <SectionCard title="Payment method">
          {searchParams.get("setup") === "complete" ? (
            <Notice tone="success">Payment method setup completed in Stripe.</Notice>
          ) : null}
          {paymentMethod?.hasPaymentMethod ? (
            <>
              <KeyValue
                label="Card on file"
                value={`${paymentMethod.brand ?? "Card"} ·••• ${paymentMethod.last4 ?? "****"}`}
              />
              {paymentMethod.expMonth && paymentMethod.expYear ? (
                <KeyValue
                  label="Expires"
                  value={`${String(paymentMethod.expMonth).padStart(2, "0")}/${paymentMethod.expYear}`}
                />
              ) : null}
            </>
          ) : (
            <Notice tone="info">
              No saved payment method yet. Add one via Stripe — card details never touch INFRA
              servers.
            </Notice>
          )}
          {wallet.stripeConfigured ? (
            <div style={{ marginTop: 16 }}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void startPaymentMethodSetup()}
              >
                {paymentMethod?.hasPaymentMethod ? "Replace payment method" : "Add payment method"}
              </Button>
              {stripeTestMode ? (
                <p className="muted small" style={{ marginTop: 8 }}>
                  Test mode — use Stripe test card 4242 4242 4242 4242.
                </p>
              ) : null}
              {paymentMethod?.hasPaymentMethod ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  style={{ marginTop: 8 }}
                  onClick={async () => {
                    if (!company) return;
                    const disableAuto =
                      autoTopUp?.enabled &&
                      window.confirm(
                        "Auto top-up is enabled. Remove payment method and disable auto top-up?",
                      );
                    if (autoTopUp?.enabled && !disableAuto) return;
                    setBusy(true);
                    try {
                      await api.removePaymentMethod(company.slug, disableAuto);
                      setPaymentMethod(await api.getPaymentMethod(company.slug).then((r) => r.paymentMethod));
                      setMessage("Payment method removed");
                    } catch (err) {
                      setMessage(err instanceof Error ? err.message : "Unable to remove payment method");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Remove payment method
                </Button>
              ) : null}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {tab === "auto-topup" ? (
        <SectionCard title="Auto top-up">
          <Notice tone="info">
            Configure automatic credit when your balance falls below a threshold. Requires a saved
            payment method. {(autoTopUp as { canExecute?: boolean })?.canExecute ? "Active in Stripe test mode." : "Execution awaits operator enablement in test mode."}
          </Notice>
          <div className="kv-stack" style={{ marginTop: 16 }}>
            <label className="field">
              <span className="field-label">When balance falls below (£)</span>
              <Input
                type="number"
                min={1}
                step={1}
                value={autoTopUpThreshold}
                onChange={(e) => setAutoTopUpThreshold(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Automatically add (£)</span>
              <select
                className="input"
                value={autoTopUpAmount}
                onChange={(e) => setAutoTopUpAmount(e.target.value)}
              >
                <option value="10">£10</option>
                <option value="25">£25</option>
                <option value="50">£50</option>
                <option value="100">£100</option>
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={autoTopUpConfirm}
                onChange={(e) => setAutoTopUpConfirm(e.target.checked)}
              />
              <span>
                I understand enabling auto top-up will charge my saved payment method when the
                threshold is reached (test mode only until live approval).
              </span>
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy || !autoTopUp?.supported}
              onClick={() => void saveAutoTopUp(true)}
            >
              {autoTopUp?.enabled ? "Update auto top-up" : "Enable auto top-up"}
            </Button>
            {autoTopUp?.enabled ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void saveAutoTopUp(false)}
              >
                Disable
              </Button>
            ) : null}
          </div>
          {autoTopUp?.message ? (
            <p className="muted small" style={{ marginTop: 12 }}>
              {autoTopUp.message}
            </p>
          ) : null}
        </SectionCard>
      ) : null}

      {tab === "transactions" ? (
        <SectionCard title="Transaction history">
          {wallet.ledger.length === 0 ? (
            <EmptyState title="No transactions yet" description="Credits and usage charges will appear here." />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Type</th>
                      <th className="num">Amount</th>
                      <th className="num">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallet.ledger.slice(0, ledgerLimit).map((entry) => (
                      <tr key={entry.id}>
                        <td className="muted small">{formatDate(entry.createdAt)}</td>
                        <td>
                          {entry.description ?? humanLedgerType(entry.entryType)}
                        </td>
                        <td>{humanLedgerType(entry.entryType)}</td>
                        <td className="num">
                          {formatCurrency(entry.amountCents, wallet.wallet.currency)}
                        </td>
                        <td className="num">
                          {formatCurrency(entry.balanceAfterCents, wallet.wallet.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {wallet.ledger.length > ledgerLimit ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  style={{ marginTop: 12 }}
                  onClick={() => setLedgerLimit((n) => n + 30)}
                >
                  Show more
                </Button>
              ) : null}
            </>
          )}
        </SectionCard>
      ) : null}

      {tab === "invoices" ? (
        <SectionCard title="Invoice history">
          <EmptyState
            title="Your INFRA invoices will appear here"
            description="When commercial billing is live, invoices generated through INFRA's accounting system will be listed with view and PDF download options."
          />
          <div style={{ marginTop: 16 }}>
            <Notice tone="info">
              Future integration requires: tenant-to-customer mapping in INFRA's Xero organisation,
              authenticated invoice retrieval, secure PDF download, and cross-tenant isolation on
              every invoice query.
            </Notice>
          </div>
        </SectionCard>
      ) : null}

      {tab === "addons" ? (
        <SectionCard title="Add-ons & upgrades" description="Optional services to extend your INFRA subscription.">
          <div className="product-grid">
            {ADDON_PRODUCTS.map((product) => (
              <ProductCard
                key={product.name}
                name={product.name}
                benefit={product.benefit}
                price={product.price}
                status="coming_soon"
                action={
                  <Button type="button" variant="secondary" size="sm" disabled>
                    Coming soon
                  </Button>
                }
              />
            ))}
          </div>
        </SectionCard>
      ) : null}
    </>
  );
}
