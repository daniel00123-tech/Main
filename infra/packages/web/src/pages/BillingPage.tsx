import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
  StatusBadge,
  formatCurrency,
} from "../components";
import { formatNumber } from "../lib/format";

export default function BillingPage() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.getBillingBalances>>>([]);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load billing");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const totals = useMemo(() => {
    const balance = rows.reduce((sum, r) => sum + r.balanceCents, 0);
    const low = rows.filter((r) => r.lowBalance).length;
    return { balance, low, companies: rows.length };
  }, [rows]);

  if (loading) return <LoadingState label="Loading billing…" />;
  if (error) {
    return <ErrorState title="Unable to load billing" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Billing"
        description="Company credit wallets across the platform. Customer-facing wallets never show INFRA margin."
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
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th className="num">Available credit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.companyId}>
                  <td>
                    <Link to={`/companies/${row.companySlug}`}>{row.companyName}</Link>
                  </td>
                  <td className="num">{formatCurrency(row.balanceCents, row.currency)}</td>
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
      )}
    </>
  );
}
