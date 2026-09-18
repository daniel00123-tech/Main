import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CreditCard, Download, Plus } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChip,
  KpiStrip,
  LoadingState,
  Modal,
  MobileRecordCard,
  MobileRecordList,
  Notice,
  PageHeader,
  SearchInput,
  SectionCard,
  ShowMoreFooter,
  StatusBadge,
  formatCurrency,
  toast,
} from "../components";
import {
  formatFullDate,
  formatMoney,
  formatShortDate,
  humanLedgerType,
  humanOperation,
} from "../lib/format";

type BalanceRow = Awaited<ReturnType<typeof api.getBillingBalances>>[number];
type Summary = Awaited<ReturnType<typeof api.getBillingSummary>>;
type LedgerRow = Awaited<ReturnType<typeof api.getBillingLedger>>[number];
type RecurringBillingCompany = Awaited<ReturnType<typeof api.getRecurringCharges>>["companies"][number];
type RecurringCharge = Awaited<ReturnType<typeof api.getRecurringCharges>>["charges"][number];
type RecurringInterval = RecurringCharge["interval"];

const ACTIVE_RECURRING_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

function formatCard(company: RecurringBillingCompany | null): string {
  if (!company?.paymentMethodReady) return "No saved card";
  const brand = company.paymentMethod.brand ?? "Card";
  const last4 = company.paymentMethod.last4 ? `•••• ${company.paymentMethod.last4}` : "saved";
  return `${brand} ${last4}`;
}

function formatBillingMode(company: RecurringBillingCompany): string {
  return company.billingMode === "live" ? "live billing" : "test billing";
}

function portalPaymentMethodPath(company: RecurringBillingCompany): string {
  return `/portal/${company.slug}/billing?tab=payment`;
}

function recurringCompanyReadinessWarnings(
  company: RecurringBillingCompany | null,
  stripeMode: string | null,
): string[] {
  if (!company) return [];
  const warnings: string[] = [];
  if (stripeMode === "live" && company.billingMode !== "live") {
    warnings.push(
      "Company billing mode is test. Live recurring card charges are blocked until this company is switched to live billing.",
    );
  }
  if (!company.paymentMethodReady) {
    warnings.push("No saved payment method is on file. Add a card in the company portal first.");
  }
  return warnings;
}

function humanInterval(interval: RecurringInterval): string {
  if (interval === "daily") return "Daily";
  if (interval === "weekly") return "Weekly";
  if (interval === "yearly") return "Yearly";
  return "Monthly";
}

function humanChargeStatus(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function BillingPage() {
  const navigate = useNavigate();
  const { companySlug: scopeCompanySlug } = useAdminScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [recurringCompanies, setRecurringCompanies] = useState<RecurringBillingCompany[]>([]);
  const [recurringCharges, setRecurringCharges] = useState<RecurringCharge[]>([]);
  const [recurringStripeConfigured, setRecurringStripeConfigured] = useState<boolean | null>(null);
  const [recurringStripeMode, setRecurringStripeMode] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    searchParams.get("company") ?? null,
  );
  const [stripeConfigured, setStripeConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [entryTypeFilter, setEntryTypeFilter] = useState<"all" | "credit" | "debit">("all");
  const [creditClassFilter, setCreditClassFilter] = useState<"all" | "paid" | "promotional">("all");
  const [creditModalOpen, setCreditModalOpen] = useState(false);
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditForm, setCreditForm] = useState({
    amountPounds: "10",
    reason: "",
    internalNote: "",
  });
  const [recurringBusy, setRecurringBusy] = useState(false);
  const [cancelingChargeId, setCancelingChargeId] = useState<string | null>(null);
  const [recurringForm, setRecurringForm] = useState<{
    companyId: string;
    amountPounds: string;
    currency: string;
    interval: RecurringInterval;
    description: string;
  }>({
    companyId: "",
    amountPounds: "50",
    currency: "GBP",
    interval: "monthly",
    description: "",
  });
  const [ledgerLimit, setLedgerLimit] = useState(25);

  const selectedRow = useMemo(
    () => rows.find((r) => r.companySlug === selectedSlug) ?? null,
    [rows, selectedSlug],
  );
  const selectedRecurringCompany = useMemo(
    () => recurringCompanies.find((company) => company.id === recurringForm.companyId) ?? null,
    [recurringCompanies, recurringForm.companyId],
  );
  const activeRecurringCharges = useMemo(
    () => recurringCharges.filter((charge) => ACTIVE_RECURRING_STATUSES.has(charge.status)),
    [recurringCharges],
  );
  const selectedRecurringWarnings = useMemo(
    () => recurringCompanyReadinessWarnings(selectedRecurringCompany, recurringStripeMode),
    [selectedRecurringCompany, recurringStripeMode],
  );
  const canCreateRecurringCharge = Boolean(recurringForm.companyId) &&
    recurringStripeConfigured !== false &&
    selectedRecurringWarnings.length === 0;

  const loadLedger = useCallback(
    async (companyId?: string) => {
      setLedgerLoading(true);
      try {
        const entries = await api.getBillingLedger({
          companyId,
          q: query.trim() || undefined,
          creditClass: creditClassFilter === "all" ? undefined : creditClassFilter,
          entryType:
            entryTypeFilter === "credit"
              ? undefined
              : entryTypeFilter === "debit"
                ? "usage_debit"
                : undefined,
          limit: 200,
        });
        const filtered =
          entryTypeFilter === "credit"
            ? entries.filter((e) => e.amountCents > 0)
            : entries;
        setLedger(filtered);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Unable to load ledger", "error");
      } finally {
        setLedgerLoading(false);
      }
    },
    [query, entryTypeFilter, creditClassFilter],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [balances, billingSummary, gateway] = await Promise.all([
        api.getBillingBalances(),
        api.getBillingSummary(),
        api.getGatewayHealth().catch(() => null),
      ]);
      const recurring = await api.getRecurringCharges();
      setRows(balances);
      setSummary(billingSummary);
      setStripeConfigured(gateway ? Boolean(gateway.stripeConfigured) : null);
      setRecurringStripeConfigured(recurring.stripeConfigured);
      setRecurringStripeMode(recurring.stripeMode ?? null);
      setRecurringCompanies(recurring.companies);
      setRecurringCharges(recurring.charges);
      setRecurringForm((current) => ({
        ...current,
        companyId:
          current.companyId && recurring.companies.some((company) => company.id === current.companyId)
            ? current.companyId
            : recurring.companies.find((company) => company.paymentMethodReady)?.id ??
              recurring.companies[0]?.id ??
              "",
      }));
      const slug =
        (scopeCompanySlug &&
        balances.some((b) => b.companySlug === scopeCompanySlug)
          ? scopeCompanySlug
          : null) ??
        (selectedSlug && balances.some((b) => b.companySlug === selectedSlug)
          ? selectedSlug
          : null) ??
        balances[0]?.companySlug ??
        null;
      setSelectedSlug(slug);
      const companyId = balances.find((b) => b.companySlug === slug)?.companyId;
      await loadLedger(companyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load billing");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scopeCompanySlug) {
      setSelectedSlug(scopeCompanySlug);
      setSearchParams({ company: scopeCompanySlug }, { replace: true });
    }
  }, [scopeCompanySlug, setSearchParams]);

  useEffect(() => {
    setLedgerLimit(25);
  }, [query, entryTypeFilter, creditClassFilter, selectedRow?.companyId]);

  useEffect(() => {
    if (!selectedRow) return;
    void loadLedger(selectedRow.companyId);
  }, [selectedRow, loadLedger]);

  useEffect(() => {
    if (selectedSlug) {
      searchParams.set("company", selectedSlug);
      setSearchParams(searchParams, { replace: true });
    }
  }, [selectedSlug, searchParams, setSearchParams]);

  function selectCompany(slug: string) {
    setSelectedSlug(slug);
  }

  function exportCsv() {
    const url = api.exportBillingLedgerUrl({
      companyId: selectedRow?.companyId,
      q: query.trim() || undefined,
      creditClass: creditClassFilter === "all" ? undefined : creditClassFilter,
    });
    window.open(`${url}`, "_blank", "noopener,noreferrer");
  }

  async function submitCredit(event: FormEvent) {
    event.preventDefault();
    if (!selectedRow) return;
    const pounds = Number(creditForm.amountPounds);
    if (!Number.isFinite(pounds) || pounds <= 0) {
      toast("Enter a valid amount", "error");
      return;
    }
    if (!creditForm.reason.trim()) {
      toast("Reason is required", "error");
      return;
    }
    setCreditBusy(true);
    try {
      await api.grantWalletCredit(selectedRow.companySlug, {
        amountCents: Math.round(pounds * 100),
        reason: creditForm.reason.trim(),
        creditClass: "promotional",
        internalNote: creditForm.internalNote.trim() || undefined,
      });
      toast(`Promotional credit of ${formatCurrency(Math.round(pounds * 100))} granted`);
      setCreditModalOpen(false);
      setCreditForm({ amountPounds: "10", reason: "", internalNote: "" });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to grant credit", "error");
    } finally {
      setCreditBusy(false);
    }
  }

  async function submitRecurringCharge(event: FormEvent) {
    event.preventDefault();
    const pounds = Number(recurringForm.amountPounds);
    if (!recurringForm.companyId) {
      toast("Select a company", "error");
      return;
    }
    if (!Number.isFinite(pounds) || pounds <= 0) {
      toast("Enter a valid recurring amount", "error");
      return;
    }
    if (!recurringForm.description.trim()) {
      toast("Description is required", "error");
      return;
    }
    const readinessWarnings = recurringCompanyReadinessWarnings(
      selectedRecurringCompany,
      recurringStripeMode,
    );
    if (readinessWarnings.length > 0) {
      toast(readinessWarnings.join(" "), "error");
      return;
    }
    setRecurringBusy(true);
    try {
      await api.createRecurringCharge({
        companyId: recurringForm.companyId,
        amountCents: Math.round(pounds * 100),
        currency: recurringForm.currency,
        interval: recurringForm.interval,
        description: recurringForm.description.trim(),
      });
      toast("Recurring company charge created");
      setRecurringForm((current) => ({ ...current, description: "" }));
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to create recurring charge", "error");
    } finally {
      setRecurringBusy(false);
    }
  }

  async function cancelRecurringCharge(charge: RecurringCharge) {
    if (!window.confirm(`Cancel recurring charge for ${charge.companyName}?`)) return;
    setCancelingChargeId(charge.id);
    try {
      await api.cancelRecurringCharge(charge.id);
      toast("Recurring charge canceled");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to cancel recurring charge", "error");
    } finally {
      setCancelingChargeId(null);
    }
  }

  if (loading) return <LoadingState label="Loading billing…" />;
  if (error) {
    return (
      <ErrorState title="Unable to load billing" description={error} onRetry={() => void load()} />
    );
  }

  return (
    <>
      <PageHeader
        title="Billing"
        description="Company wallets and immutable ledger. Usage charges and top-ups share one financial source of truth."
        actions={
          <>
            <Button variant="secondary" onClick={() => exportCsv()}>
              <Download size={14} /> Export CSV
            </Button>
            {selectedRow ? (
              <Button variant="primary" onClick={() => setCreditModalOpen(true)}>
                <Plus size={14} /> Add promotional credit
              </Button>
            ) : null}
          </>
        }
      />

      {stripeConfigured === false ? (
        <Notice tone="warning">
          Online payments not configured. Customer top-ups require Stripe. Provider costs remain
          unknown unless rate cards exist — never shown as £0.
        </Notice>
      ) : stripeConfigured ? (
        <Notice tone="info">
          Stripe credentials are present. Live charging requires explicit go-live approval.
        </Notice>
      ) : null}

      {summary ? (
        <KpiStrip
          items={[
            {
              label: "Companies with wallets",
              value: summary.companyCount,
              hint: `${summary.lowBalanceCount} low balance`,
            },
            {
              label: "Total credit held",
              value: formatCurrency(summary.totalWalletCents),
            },
            {
              label: "Spend this month",
              value: formatCurrency(summary.spendThisMonthCents),
            },
            {
              label: "Credits added this month",
              value: formatCurrency(summary.creditsAddedThisMonthCents),
            },
            {
              label: "Promotional credit outstanding",
              value: formatCurrency(summary.totalPromotionalCreditCents),
              hint: `Paid: ${formatCurrency(summary.totalPaidCreditCents)}`,
            },
          ]}
        />
      ) : null}

      <Notice tone="info">
        Paid and promotional credit are classified separately for reporting. The wallet balance is
        a single pooled amount — usage draws from total available credit. Promotional-first
        consumption is not applied separately in the current accounting model.
      </Notice>

      <SectionCard
        title="Recurring company charges"
        description="Create blanket SaaS subscriptions for individual companies using their saved Stripe payment method."
        className="mt-6"
      >
        {recurringStripeConfigured === false ? (
          <Notice tone="warning">
            Stripe recurring billing is not configured. Add Stripe Worker secrets before creating
            live recurring charges.
          </Notice>
        ) : null}

        <div className="grid grid-2" style={{ alignItems: "start", marginTop: 12 }}>
          <form onSubmit={(event) => void submitRecurringCharge(event)} className="stack">
            <label className="field">
              <span>Company</span>
              <select
                value={recurringForm.companyId}
                onChange={(e) =>
                  setRecurringForm((form) => ({ ...form, companyId: e.target.value }))
                }
                required
              >
                <option value="" disabled>
                  Select company
                </option>
                {recurringCompanies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name} · {formatBillingMode(company)} ·{" "}
                    {company.paymentMethodReady ? formatCard(company) : "no card on file"}
                  </option>
                ))}
              </select>
            </label>

            {selectedRecurringCompany ? (
              selectedRecurringWarnings.length === 0 ? (
                <Notice tone="success">
                  <strong>{selectedRecurringCompany.name}</strong> is on{" "}
                  {formatBillingMode(selectedRecurringCompany)} and will be charged via{" "}
                  {formatCard(selectedRecurringCompany)}.
                </Notice>
              ) : (
                <Notice tone="warning">
                  <strong>{selectedRecurringCompany.name}</strong> is not ready for a recurring
                  live charge.
                  <ul style={{ margin: "8px 0 0 20px", padding: 0 }}>
                    {selectedRecurringWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  {!selectedRecurringCompany.paymentMethodReady ? (
                    <p style={{ margin: "8px 0 0" }}>
                      Card-add path:{" "}
                      <Link to={portalPaymentMethodPath(selectedRecurringCompany)}>
                        {portalPaymentMethodPath(selectedRecurringCompany)}
                      </Link>
                    </p>
                  ) : null}
                </Notice>
              )
            ) : null}

            <div className="grid grid-2" style={{ gap: 12 }}>
              <label className="field">
                <span>Amount (£)</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={recurringForm.amountPounds}
                  onChange={(e) =>
                    setRecurringForm((form) => ({ ...form, amountPounds: e.target.value }))
                  }
                  required
                />
              </label>
              <label className="field">
                <span>Frequency</span>
                <select
                  value={recurringForm.interval}
                  onChange={(e) =>
                    setRecurringForm((form) => ({
                      ...form,
                      interval: e.target.value as RecurringInterval,
                    }))
                  }
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </label>
            </div>

            <label className="field">
              <span>Currency</span>
              <select
                value={recurringForm.currency}
                onChange={(e) =>
                  setRecurringForm((form) => ({ ...form, currency: e.target.value }))
                }
              >
                <option value="GBP">GBP</option>
              </select>
            </label>

            <label className="field">
              <span>Description of charge</span>
              <textarea
                rows={3}
                value={recurringForm.description}
                onChange={(e) =>
                  setRecurringForm((form) => ({ ...form, description: e.target.value }))
                }
                placeholder="e.g. EL Business agent bot monthly subscription"
                required
              />
            </label>

            <Button
              type="submit"
              variant="primary"
              loading={recurringBusy}
              disabled={!canCreateRecurringCharge}
            >
              <CreditCard size={14} /> Create recurring charge
            </Button>
          </form>

          <div>
            <div className="card-header-row" style={{ marginBottom: 12 }}>
              <div>
                <h3 className="section-title">Active recurring charges</h3>
                <p className="muted small" style={{ margin: "4px 0 0" }}>
                  Stripe subscriptions created by platform administrators.
                </p>
              </div>
            </div>
            {activeRecurringCharges.length === 0 ? (
              <EmptyState
                title="No active recurring charges"
                description="Create a recurring company charge to start a Stripe subscription."
              />
            ) : (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Description</th>
                      <th className="num">Amount</th>
                      <th>Frequency</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {activeRecurringCharges.map((charge) => (
                      <tr key={charge.id}>
                        <td>
                          <Link to={`/companies/${charge.companySlug}?tab=billing`}>
                            {charge.companyName}
                          </Link>
                          <div className="muted small">{charge.paymentMethod.brand ?? "Card"} {charge.paymentMethod.last4 ? `•••• ${charge.paymentMethod.last4}` : ""}</div>
                        </td>
                        <td>
                          <div className="ledger-row-primary">{charge.description}</div>
                          <div className="ledger-row-meta">
                            {charge.stripeSubscriptionId ?? "Stripe subscription pending"}
                          </div>
                        </td>
                        <td className="num">{formatCurrency(charge.amountCents, charge.currency)}</td>
                        <td>{humanInterval(charge.interval)}</td>
                        <td>
                          <StatusBadge status={charge.status} label={humanChargeStatus(charge.status)} />
                        </td>
                        <td className="num">
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            loading={cancelingChargeId === charge.id}
                            onClick={() => void cancelRecurringCharge(charge)}
                          >
                            Cancel
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      {rows.length === 0 ? (
        <EmptyState
          title="No wallets yet"
          description="Company wallets appear after a company is provisioned with billing."
        />
      ) : (
        <>
          <SectionCard title="Wallets" description="Tap a company to view wallet detail and ledger.">
            <div className="table-wrap desktop-only">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th className="num">Paid credit</th>
                    <th className="num">Promotional</th>
                    <th className="num">Total available</th>
                    <th className="num">Spend this month</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.companyId}
                      style={{
                        cursor: "pointer",
                        background:
                          row.companySlug === selectedSlug ? "var(--accent-soft)" : undefined,
                      }}
                      onClick={() => selectCompany(row.companySlug)}
                    >
                      <td>
                        <Link
                          to={`/companies/${row.companySlug}?tab=billing`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.companyName}
                        </Link>
                      </td>
                      <td className="num">{formatCurrency(row.paidCreditCents, row.currency)}</td>
                      <td className="num">
                        {formatCurrency(row.promotionalCreditCents, row.currency)}
                      </td>
                      <td className="num">{formatCurrency(row.balanceCents, row.currency)}</td>
                      <td className="num">
                        {formatCurrency(row.spendThisMonthCents, row.currency)}
                      </td>
                      <td>
                        <StatusBadge
                          status={row.lowBalance ? "warning" : "healthy"}
                          label={row.lowBalance ? "Low balance" : "OK"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-only">
              <MobileRecordList>
                {rows.map((row) => (
                  <MobileRecordCard
                    key={row.companyId}
                    onClick={() => selectCompany(row.companySlug)}
                    className={row.companySlug === selectedSlug ? "selected-record" : ""}
                  >
                    <div className="mobile-record-header">
                      <strong>{row.companyName}</strong>
                      <StatusBadge
                        status={row.lowBalance ? "warning" : "healthy"}
                        label={row.lowBalance ? "Low balance" : "OK"}
                      />
                    </div>
                    <dl className="mobile-record-meta">
                      <div>
                        <dt>Paid</dt>
                        <dd>{formatCurrency(row.paidCreditCents, row.currency)}</dd>
                      </div>
                      <div>
                        <dt>Promotional</dt>
                        <dd>{formatCurrency(row.promotionalCreditCents, row.currency)}</dd>
                      </div>
                      <div>
                        <dt>Available</dt>
                        <dd>{formatCurrency(row.balanceCents, row.currency)}</dd>
                      </div>
                      <div>
                        <dt>Spend (mo)</dt>
                        <dd>{formatCurrency(row.spendThisMonthCents, row.currency)}</dd>
                      </div>
                    </dl>
                  </MobileRecordCard>
                ))}
              </MobileRecordList>
            </div>
          </SectionCard>

          {selectedRow ? (
            <SectionCard
              title={selectedRow.companyName}
              description="Paid and promotional credit are classified from ledger entries. Consumption draws from the pooled balance."
              className="mt-6"
              actions={
                <Button variant="secondary" size="sm" onClick={() => setCreditModalOpen(true)}>
                  Add promotional credit
                </Button>
              }
            >
              <div className="kpi-strip" style={{ marginBottom: 16 }}>
                <div className="kpi-item">
                  <div className="kpi-item-label">Paid credit</div>
                  <div className="kpi-item-value">
                    {formatCurrency(selectedRow.paidCreditCents, selectedRow.currency)}
                  </div>
                </div>
                <div className="kpi-item">
                  <div className="kpi-item-label">Promotional credit</div>
                  <div className="kpi-item-value">
                    {formatCurrency(selectedRow.promotionalCreditCents, selectedRow.currency)}
                  </div>
                </div>
                <div className="kpi-item">
                  <div className="kpi-item-label">Total available</div>
                  <div className="kpi-item-value">
                    {formatCurrency(selectedRow.balanceCents, selectedRow.currency)}
                  </div>
                </div>
              </div>

              <FilterBar>
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder="Search ledger…"
                  className="grow"
                />
                <div className="filter-chips">
                  {(
                    [
                      ["all", "All"],
                      ["credit", "Credits"],
                      ["debit", "Debits"],
                    ] as const
                  ).map(([id, label]) => (
                    <FilterChip
                      key={id}
                      active={entryTypeFilter === id}
                      onClick={() => setEntryTypeFilter(id)}
                    >
                      {label}
                    </FilterChip>
                  ))}
                  {(
                    [
                      ["all", "All credit types"],
                      ["paid", "Paid"],
                      ["promotional", "Promotional"],
                    ] as const
                  ).map(([id, label]) => (
                    <FilterChip
                      key={id}
                      active={creditClassFilter === id}
                      onClick={() => setCreditClassFilter(id)}
                    >
                      {label}
                    </FilterChip>
                  ))}
                </div>
              </FilterBar>

              {ledgerLoading ? (
                <LoadingState label="Loading ledger…" />
              ) : ledger.length === 0 ? (
                <p className="muted">No ledger entries match your filters.</p>
              ) : (
                <>
                <div className="table-wrap desktop-only" style={{ marginTop: 12 }}>
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>Date & time</th>
                        <th>User / source</th>
                        <th>Description</th>
                        <th className="num">Amount</th>
                        <th className="num">Balance after</th>
                        <th>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.slice(0, ledgerLimit).map((entry) => (
                        <tr
                          key={entry.id}
                          style={{
                            cursor: entry.entryType.includes("usage") ? "pointer" : undefined,
                          }}
                          onClick={() => {
                            if (entry.entryType.includes("usage")) navigate("/usage");
                          }}
                        >
                          <td>
                            <div className="ledger-row-primary">{formatShortDate(entry.createdAt)}</div>
                            <div className="ledger-row-meta">{formatFullDate(entry.createdAt)}</div>
                          </td>
                          <td>{entry.sourceLabel}</td>
                          <td>
                            <div className="ledger-row-primary">
                              {entry.description
                                ? humanOperation(entry.description.split(" · ").pop())
                                : humanLedgerType(entry.entryType)}
                            </div>
                            <div className="ledger-row-meta">{entry.companyName}</div>
                          </td>
                          <td className="num">
                            <span
                              className={
                                entry.amountCents >= 0
                                  ? "ledger-amount-credit"
                                  : "ledger-amount-debit"
                              }
                            >
                              {formatMoney(entry.amountCents, entry.currency, { signed: true })}
                            </span>
                          </td>
                          <td className="num">
                            {formatCurrency(entry.balanceAfterCents, entry.currency)}
                          </td>
                          <td>
                            {entry.creditClass ? (
                              <StatusBadge
                                status={entry.creditClass === "paid" ? "configured" : "pending"}
                                label={
                                  entry.creditClass === "paid" ? "Paid credit" : "Promotional"
                                }
                              />
                            ) : (
                              <span className="muted small">{humanLedgerType(entry.entryType)}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mobile-only" style={{ marginTop: 12 }}>
                  <MobileRecordList>
                    {ledger.slice(0, ledgerLimit).map((entry) => (
                      <MobileRecordCard
                        key={entry.id}
                        onClick={() => {
                          if (entry.entryType.includes("usage")) navigate("/usage");
                        }}
                      >
                        <div className="mobile-record-header">
                          <div>
                            <div className="ledger-row-primary">{formatShortDate(entry.createdAt)}</div>
                            <div className="ledger-row-meta">{entry.sourceLabel}</div>
                          </div>
                          <span
                            className={
                              entry.amountCents >= 0 ? "ledger-amount-credit" : "ledger-amount-debit"
                            }
                          >
                            {formatMoney(entry.amountCents, entry.currency, { signed: true })}
                          </span>
                        </div>
                        <p className="small" style={{ margin: "8px 0 0" }}>
                          {entry.description
                            ? humanOperation(entry.description.split(" · ").pop())
                            : humanLedgerType(entry.entryType)}
                        </p>
                        <div className="muted small" style={{ marginTop: 4 }}>
                          Balance after {formatCurrency(entry.balanceAfterCents, entry.currency)}
                        </div>
                      </MobileRecordCard>
                    ))}
                  </MobileRecordList>
                </div>
                <ShowMoreFooter
                  shown={Math.min(ledgerLimit, ledger.length)}
                  total={ledger.length}
                  onShowMore={() => setLedgerLimit((n) => n + 25)}
                />
                </>
              )}
            </SectionCard>
          ) : null}
        </>
      )}

      <Modal
        open={creditModalOpen}
        onClose={() => setCreditModalOpen(false)}
        title="Add promotional credit"
        description={
          selectedRow
            ? `Grant free credit to ${selectedRow.companyName}. Creates an immutable ledger entry and audit record.`
            : undefined
        }
      >
        <form onSubmit={(e) => void submitCredit(e)} className="stack">
          <label className="field">
            <span>Amount (£)</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={creditForm.amountPounds}
              onChange={(e) => setCreditForm((f) => ({ ...f, amountPounds: e.target.value }))}
              required
            />
          </label>
          <label className="field">
            <span>Reason (required)</span>
            <input
              value={creditForm.reason}
              onChange={(e) => setCreditForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="e.g. New customer onboarding credit"
              required
            />
          </label>
          <label className="field">
            <span>Internal note (optional)</span>
            <textarea
              value={creditForm.internalNote}
              onChange={(e) => setCreditForm((f) => ({ ...f, internalNote: e.target.value }))}
              rows={2}
            />
          </label>
          <Notice tone="info">
            Promotional credit is classified separately from Stripe-paid credit. It is not customer
            money received.
          </Notice>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setCreditModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={creditBusy}>
              Confirm grant
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
