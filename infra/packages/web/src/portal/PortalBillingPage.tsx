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
  stripeMode?: string | null;
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
  const [autoTopUpThreshold, setAutoTopUpThreshold] = useState("25");
  const [autoTopUpAmount, setAutoTopUpAmount] = useState("25");
  const [autoTopUpConfirm, setAutoTopUpConfirm] = useState(false);
  const [payments, setPayments] = useState<Array<Record<string, unknown>>>([]);

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
        const data = await reloadWallet();
        const providerAutoTopUp = data?.paymentProvider?.autoTopUp;
        if (providerAutoTopUp?.thresholdCents != null) {
          setAutoTopUpThreshold(String(providerAutoTopUp.thresholdCents / 100));
        }
        if (providerAutoTopUp?.amountCents != null) {
          setAutoTopUpAmount(String(providerAutoTopUp.amountCents / 100));
        }
        if (
          tab === "payment" ||
          tab === "auto-topup" ||
          searchParams.get("setup") === "complete" ||
          searchParams.get("topup") === "success"
        ) {
          const pm = await api.getPaymentMethod(company.slug);
          setPaymentMethod(pm.paymentMethod);
        }
        if (tab === "invoices") {
          const p = await api.getBillingPayments(company.slug);
          setPayments(p.payments);
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
  const topUpCheckoutAllowed = wallet.paymentProvider?.topUpCheckoutAllowed ?? stripeTestMode;
  const topUpBlockedReason = wallet.paymentProvider?.topUpBlockedReason ?? null;
  const companyBillingMode = wallet.paymentProvider?.companyBillingMode ?? "test";
  const recentTopUps = (wallet.recentTopUps ?? []) as TopUpRecord[];
  const minTopUpCents =
    companyBillingMode === "live" && !stripeTestMode ? 100 : stripeTestMode ? 100 : 500;
  const topUpOptions = wallet.topUpOptionsCents.filter((amount) => amount >= minTopUpCents);
  const customTopUpMinPounds = minTopUpCents / 100;
  const autoTopUp = wallet.paymentProvider?.autoTopUp;
  const spendThisMonth =
    wallet.wallet.spendThisMonthCents ??
    wallet.billing?.spendThisMonthCents ??
    0;
  const walletHealth = wallet.wallet.walletHealthState ?? (wallet.wallet.lowBalance ? "low" : "healthy");
  const savedCardLabel = paymentMethod?.hasPaymentMethod
    ? `${paymentMethod.brand ?? "Card"} •••• ${paymentMethod.last4 ?? "****"}`
    : null;
  const autoTopUpThresholdPounds = Number(autoTopUpThreshold) || 25;
  const autoTopUpAmountPounds = Number(autoTopUpAmount) || 25;
  const topUpUnavailableMessage =
    topUpBlockedReason &&
    !/billing mode|stripe|operator|sandbox|execution|unconfigured/i.test(topUpBlockedReason)
      ? topUpBlockedReason
      : "Card top-up is not available right now. Contact support if you need help adding credit.";

  async function startPaymentMethodSetup() {
    if (!company) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.startPaymentMethodSetup(company.slug);
      if (typeof result.url === "string" && result.url.startsWith("http")) {
        window.location.href = result.url;
        return;
      }
      setMessage("Unable to start card setup. Please try again or contact support.");
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
      setMessage(enabled ? "Auto top-up saved." : "Auto top-up turned off.");
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
          <strong>Test mode</strong> — card payments are for testing only. No real money is collected.
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

      {message ? (
        <Notice tone={message.toLowerCase().includes("fail") || message.toLowerCase().includes("unable") ? "danger" : "info"}>
          {message}
        </Notice>
      ) : null}

      <Tabs
        active={tab}
        onChange={(id) => setTab(id as BillingTab)}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "payment", label: "Payment method" },
          { id: "auto-topup", label: "Auto top-up" },
          { id: "transactions", label: "Transactions" },
          { id: "invoices", label: "Payments" },
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
                label: "Non-purchased credit",
                value: formatCurrency(wallet.wallet.testCreditCents ?? 0, wallet.wallet.currency),
                hint: "Promotional and test credit",
              },
              {
                label: "Spend this month",
                value: formatCurrency(spendThisMonth, wallet.wallet.currency),
                hint: "Usage charges this month",
              },
              {
                label: "Paid credit",
                value: formatCurrency(wallet.wallet.paidCreditCents ?? 0, wallet.wallet.currency),
                hint: "Credit you've paid for",
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

          <SectionCard title="Add credit" description="Secure payment powered by Stripe.">
            {wallet.stripeConfigured && topUpCheckoutAllowed ? (
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
                    min={customTopUpMinPounds}
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
                      if (Number.isFinite(pounds) && pounds >= customTopUpMinPounds) {
                        void topUp(Math.round(pounds * 100));
                      }
                    }}
                  >
                    Top up custom amount
                  </Button>
                </div>
              </>
            ) : (
              <p className="muted">
                {wallet.stripeConfigured
                  ? topUpUnavailableMessage
                  : "Online payments are not configured yet."}
              </p>
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
                        <td>
                          {formatCurrency(topUp.amountCents, topUp.currency)}
                          {topUp.stripeMode === "test" ? (
                            <span className="muted small"> (Test)</span>
                          ) : null}
                        </td>
                        <td>
                          {topUp.status === "credited"
                            ? "Complete"
                            : topUp.status === "pending"
                              ? "Pending"
                              : topUp.status === "failed"
                                ? "Failed"
                                : topUp.status.replace(/_/g, " ")}
                        </td>
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
          {searchParams.get("setup") === "complete" && paymentMethod?.hasPaymentMethod ? (
            <Notice tone="success">Payment method saved.</Notice>
          ) : searchParams.get("setup") === "complete" && !paymentMethod?.hasPaymentMethod ? (
            <Notice tone="info">
              Your card details were submitted. If your card is not shown yet, refresh this page.
            </Notice>
          ) : null}
          {paymentMethod?.hasPaymentMethod ? (
            <>
              <KeyValue
                label="Card on file"
                value={`${paymentMethod.brand ?? "Card"} •••• ${paymentMethod.last4 ?? "****"}`}
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
              No saved payment method yet. Add a card to pay for credit and enable auto top-up.
              Payments are handled securely by Stripe.
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
                  Test mode — use test card number 4242 4242 4242 4242 when adding a card.
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
        <SectionCard
          title="Auto top-up"
          description="Automatically add credit when your balance falls below the amount you choose."
        >
          {autoTopUp?.enabled ? (
            <div className="billing-auto-topup-status">
              <KeyValue label="Auto top-up" value="On" />
              <KeyValue
                label="Settings"
                value={`Below ${formatCurrency(autoTopUp.thresholdCents ?? autoTopUpThresholdPounds * 100, wallet.wallet.currency)} → add ${formatCurrency(autoTopUp.amountCents ?? autoTopUpAmountPounds * 100, wallet.wallet.currency)}`}
              />
              <KeyValue
                label="Saved card"
                value={savedCardLabel ?? "No card saved yet"}
              />
            </div>
          ) : (
            <Notice tone="info">
              Turn on auto top-up to add credit automatically when your balance gets low. A saved
              card is required.
            </Notice>
          )}

          <div className="kv-stack billing-auto-topup-form">
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
            <label className="billing-consent">
              <input
                type="checkbox"
                checked={autoTopUpConfirm}
                onChange={(e) => setAutoTopUpConfirm(e.target.checked)}
              />
              <span className="billing-consent-text">
                Automatically top up my account when my balance falls below £
                {autoTopUpThresholdPounds}, adding £{autoTopUpAmountPounds} each time.
              </span>
            </label>
          </div>

          <div className="billing-auto-topup-actions">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy || !autoTopUp?.supported || !savedCardLabel}
              onClick={() => void saveAutoTopUp(true)}
            >
              {autoTopUp?.enabled ? "Save changes" : "Turn on auto top-up"}
            </Button>
            {autoTopUp?.enabled ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void saveAutoTopUp(false)}
              >
                Turn off auto top-up
              </Button>
            ) : null}
          </div>

          {!savedCardLabel ? (
            <p className="muted small" style={{ marginTop: 12 }}>
              Add a payment method before turning on auto top-up.
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
        <SectionCard title="Payment history" description="Your card payments and credit added to your account.">
          {payments.length === 0 ? (
            <EmptyState
              title="No payment records yet"
              description="Your card payments and credits added to your account will appear here."
            />
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Type</th>
                    <th className="num">Amount</th>
                    <th>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => {
                    const stripeMode = p.stripeMode ? String(p.stripeMode) : null;
                    const isTestStripeTopUp =
                      stripeMode === "test" ||
                      (p.entryType === "top_up" && p.creditClass === "test");
                    const typeLabel =
                      p.entryType === "top_up"
                        ? isTestStripeTopUp
                          ? "Top-up (Test)"
                          : "Top-up"
                        : p.creditClass === "test"
                          ? "Promotional credit"
                          : p.creditClass === "paid"
                            ? "Top-up"
                            : String(p.entryType);
                    return (
                    <tr key={String(p.id)}>
                      <td className="muted small">{formatDate(String(p.date))}</td>
                      <td>{String(p.description ?? p.entryType)}</td>
                      <td>{typeLabel}</td>
                      <td className="num">{formatCurrency(Number(p.amountCents), wallet.wallet.currency)}</td>
                      <td>
                        {p.receiptUrl ? (
                          <a href={String(p.receiptUrl)} target="_blank" rel="noreferrer">
                            View receipt
                          </a>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <Notice tone="info">
              Accounting invoices from Xero will appear separately when that workflow is enabled.
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
