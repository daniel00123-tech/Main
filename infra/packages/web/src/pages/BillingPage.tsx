import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Wallet } from "lucide-react";
import { api } from "../api";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  MetricGrid,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  formatDate,
} from "../components";
import { formatNumber } from "../lib/format";

const OPENING_TEST_CREDIT_CENTS = 1000;

type BalanceRow = Awaited<ReturnType<typeof api.getBillingBalances>>[number];
type WalletDetail = Awaited<ReturnType<typeof api.getWallet>>;

export default function BillingPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletDetail | null>(null);
  const [stripeConfigured, setStripeConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [balances, gateway] = await Promise.all([
        api.getBillingBalances(),
        api.getGatewayHealth().catch(() => null),
      ]);
      setRows(balances);
      setStripeConfigured(gateway ? Boolean(gateway.stripeConfigured) : null);
      const preferred =
        balances.find((b) => b.companySlug === "caddington") ?? balances[0] ?? null;
      if (preferred) {
        setSelectedSlug(preferred.companySlug);
        setWallet(await api.getWallet(preferred.companySlug));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load billing");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function selectCompany(slug: string) {
    setSelectedSlug(slug);
    setWallet(await api.getWallet(slug));
  }

  const totals = useMemo(() => {
    const balance = rows.reduce((sum, r) => sum + r.balanceCents, 0);
    const low = rows.filter((r) => r.lowBalance).length;
    return { balance, low, companies: rows.length };
  }, [rows]);

  const selectedBalance = rows.find((r) => r.companySlug === selectedSlug) ?? null;
  const usedCents =
    wallet && selectedBalance
      ? Math.max(0, OPENING_TEST_CREDIT_CENTS - selectedBalance.balanceCents)
      : 0;

  if (loading) return <LoadingState label="Loading billing…" />;
  if (error) {
    return <ErrorState title="Unable to load billing" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Billing"
        description="Company credit wallets. Ledger is the financial source of truth — Usage and Billing share the same accounting data."
      />

      {stripeConfigured === false ? (
        <Notice tone="warning">
          Stripe is not configured on the API. Wallet balances are real; card top-ups are unavailable until
          secrets are set.
        </Notice>
      ) : null}

      <MetricGrid cols={3}>
        <MetricCard
          label="Companies with wallets"
          value={formatNumber(totals.companies)}
          icon={<Wallet size={16} />}
        />
        <MetricCard label="Total credit held" value={formatCurrency(totals.balance)} />
        <MetricCard label="Low balance" value={formatNumber(totals.low)} />
      </MetricGrid>

      {rows.length === 0 ? (
        <EmptyState
          title="No wallets yet"
          description="Company wallets appear after a company is provisioned with billing."
        />
      ) : (
        <div className="grid grid-2" style={{ marginTop: 16, gap: 24 }}>
          <SectionCard title="Wallets">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th className="num">Available</th>
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
                          row.companySlug === selectedSlug
                            ? "var(--accent-soft)"
                            : undefined,
                      }}
                      onClick={() => void selectCompany(row.companySlug)}
                    >
                      <td>
                        <Link
                          to={`/companies/${row.companySlug}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.companyName}
                        </Link>
                      </td>
                      <td className="num">
                        {formatCurrency(row.balanceCents, row.currency)}
                      </td>
                      <td>
                        <StatusBadge
                          status={row.lowBalance ? "warning" : "active"}
                          label={row.lowBalance ? "Low balance" : "OK"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {selectedBalance && wallet ? (
            <SectionCard
              title={selectedBalance.companyName}
              description={
                selectedBalance.companySlug === "caddington"
                  ? "Test Credit"
                  : "Prepaid credit"
              }
            >
              <div className="metric" style={{ fontSize: "var(--text-3xl)", marginBottom: 12 }}>
                {formatCurrency(selectedBalance.balanceCents, selectedBalance.currency)}
              </div>
              {selectedBalance.companySlug === "caddington" ? (
                <div className="kv-stack" style={{ marginBottom: 16 }}>
                  <div className="muted small">
                    Starting credit: {formatCurrency(OPENING_TEST_CREDIT_CENTS)}
                  </div>
                  <div className="muted small">Used: {formatCurrency(usedCents)}</div>
                  <div className="muted small">
                    Remaining:{" "}
                    {formatCurrency(selectedBalance.balanceCents, selectedBalance.currency)}
                  </div>
                </div>
              ) : null}

              <h4 className="section-title" style={{ marginTop: 8 }}>
                Ledger
              </h4>
              {wallet.ledger.length === 0 ? (
                <p className="muted">No ledger entries yet.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Entry</th>
                        <th className="num">Amount</th>
                        <th className="num">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wallet.ledger.map((entry) => (
                        <tr
                          key={entry.id}
                          style={{
                            cursor: entry.entryType.includes("usage")
                              ? "pointer"
                              : undefined,
                          }}
                          onClick={() => {
                            if (entry.entryType.includes("usage")) {
                              navigate("/usage");
                            }
                          }}
                        >
                          <td>
                            <strong>
                              {entry.amountCents >= 0 ? "+" : "−"}{" "}
                              {formatCurrency(Math.abs(entry.amountCents))}
                            </strong>
                            <div className="muted small">
                              {entry.description ?? humanLedgerType(entry.entryType)}
                            </div>
                            <div className="muted small">{formatDate(entry.createdAt)}</div>
                          </td>
                          <td className="num">
                            {formatCurrency(entry.amountCents, selectedBalance.currency)}
                          </td>
                          <td className="num">
                            {formatCurrency(
                              entry.balanceAfterCents,
                              selectedBalance.currency,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          ) : null}
        </div>
      )}
    </>
  );
}

function humanLedgerType(type: string): string {
  const map: Record<string, string> = {
    top_up: "Top up",
    promotional_credit: "Test credit",
    manual_credit: "Manual credit",
    usage_debit: "Usage",
    usage: "Usage",
    debit: "Usage",
    refund: "Refund",
    adjustment: "Adjustment",
  };
  return map[type] ?? type.replace(/_/g, " ");
}
