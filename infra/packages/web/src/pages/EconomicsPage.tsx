import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PoundSterling } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  MetricCard,
  MetricGrid,
  Notice,
  PageHeader,
  Select,
  formatCurrency,
} from "../components";

export default function EconomicsPage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [preset, setPreset] = useState("current_month");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getCustomerEconomics>> | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.getCustomerEconomics({
          companyId: scopeCompanyId || undefined,
          preset,
          provider: provider || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load economics");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [preset, provider, scopeCompanyId]);

  const totals = useMemo(() => {
    const rows = data?.companies ?? [];
    const revenue = rows.reduce((sum, row) => sum + row.revenueCents, 0);
    const cost = rows.reduce((sum, row) => sum + row.directCostCents, 0);
    return { revenue, cost, profit: revenue - cost, customers: rows.length };
  }, [data]);

  if (loading) return <LoadingState label="Loading customer economics…" />;
  if (error) return <ErrorState title="Unable to load economics" description={error} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader
        title="Customer Economics"
        description="Direct attributable cost versus recognised usage charges. Platform overheads are shown separately and are not allocated to customers."
      />
      <Notice tone="info">
        Revenue is usage charges from the existing wallet model. Cash collected from Stripe/wallet
        top-ups is shown separately and is not mixed into margin. Stripe fees are estimated from
        published UK card rates. Cloudflare Workers/D1/R2 are not attributable in V1.
      </Notice>
      <FilterBar>
        <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="current_month">Current month</option>
          <option value="previous_month">Previous month</option>
        </Select>
        <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All providers</option>
          <option value="ocr">OCR / Azure</option>
          <option value="ai_model">AI / model</option>
          <option value="stripe">Stripe fees</option>
          <option value="other">Other attributable</option>
        </Select>
      </FilterBar>
      <MetricGrid>
        <MetricCard label="Recognised revenue" value={formatCurrency(totals.revenue)} />
        <MetricCard label="Direct cost" value={formatCurrency(totals.cost)} />
        <MetricCard label="Gross profit" value={formatCurrency(totals.profit)} />
        <MetricCard
          label="Platform overheads (not allocated)"
          value={formatCurrency(data?.platformOverheads.monthlyCostCents ?? 0)}
        />
      </MetricGrid>
      {(data?.companies.length ?? 0) === 0 ? (
        <EmptyState
          icon={<PoundSterling size={28} />}
          title="No customer economics yet"
          description="Usage and billing events in the selected period will appear here."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Revenue</th>
                <th>Direct cost</th>
                <th>Gross profit</th>
                <th>Margin</th>
                <th>Active users</th>
                <th>Cost / user</th>
              </tr>
            </thead>
            <tbody>
              {data?.companies.map((row) => (
                <tr key={row.companyId}>
                  <td>
                    <Link to={`/economics/${row.companyId}?preset=${preset}`} className="table-link">
                      {row.companyName}
                    </Link>
                  </td>
                  <td>{formatCurrency(row.revenueCents)}</td>
                  <td>{formatCurrency(row.directCostCents)}</td>
                  <td>{formatCurrency(row.grossProfitCents ?? 0)}</td>
                  <td>{row.grossMarginPercent == null ? "—" : `${row.grossMarginPercent}%`}</td>
                  <td>{row.activeUsers}</td>
                  <td>
                    {row.costPerActiveUserCents == null
                      ? "—"
                      : formatCurrency(row.costPerActiveUserCents)}
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
