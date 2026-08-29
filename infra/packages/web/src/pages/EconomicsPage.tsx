import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PoundSterling } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  DataCard,
  EmptyState,
  ErrorState,
  FilterBar,
  HelpHint,
  LoadingState,
  MetricCard,
  MetricGrid,
  MobileRecordList,
  PageHeader,
  RatioBar,
  SectionCard,
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
    const activeCustomers = rows.filter((row) => row.revenueCents > 0 || row.directCostCents > 0 || row.activeUsers > 0).length;
    const activeUsers = rows.reduce((sum, row) => sum + row.activeUsers, 0);
    return {
      revenue,
      cost,
      profit: revenue - cost,
      margin: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 10000) / 100 : null,
      activeCustomers,
      costPerUser: activeUsers > 0 ? Math.round(cost / activeUsers) : null,
    };
  }, [data]);

  const ranked = useMemo(
    () => [...(data?.companies ?? [])].sort((a, b) => (b.grossProfitCents ?? 0) - (a.grossProfitCents ?? 0)),
    [data],
  );

  if (loading) return <LoadingState label="Loading profitability…" />;
  if (error) return <ErrorState title="Unable to load economics" description={error} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader
        title="Customer economics"
        description="Recognised customer revenue minus the cost of serving those customers."
      />
      <FilterBar>
        <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="current_month">Current month</option>
          <option value="previous_month">Previous month</option>
        </Select>
        <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All cost sources</option>
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
        <MetricCard label="Gross margin" value={totals.margin == null ? "—" : `${totals.margin}%`} />
        <MetricCard label="Active customers" value={String(totals.activeCustomers)} />
        <MetricCard
          label="Cost per active user"
          value={totals.costPerUser == null ? "—" : formatCurrency(totals.costPerUser)}
        />
      </MetricGrid>
      <SectionCard
        title="Revenue minus direct serving cost"
        description={
          <>
            Gross profit is recognised usage charges minus attributable serving cost.
            <HelpHint label="How revenue is calculated">
              Recognised revenue is usage charged to customer wallets. Cash collected from top-ups is
              tracked separately and is not mixed into margin.
            </HelpHint>
          </>
        }
      >
        <RatioBar
          left={totals.revenue}
          right={totals.cost}
          leftLabel={`Revenue ${formatCurrency(totals.revenue)}`}
          rightLabel={`Direct cost ${formatCurrency(totals.cost)}`}
        />
        <p className="muted small">
          Platform overheads ({formatCurrency(data?.platformOverheads.monthlyCostCents ?? 0)} / month) are
          not allocated to customers.
        </p>
      </SectionCard>

      {ranked.length === 0 ? (
        <EmptyState
          icon={<PoundSterling size={28} />}
          title="No customer economics yet"
          description="This is normal before customers generate usage. Figures appear once wallet charges or serving costs land in the selected period."
        />
      ) : (
        <>
          <div className="mobile-cards">
            <MobileRecordList>
              {ranked.map((row) => (
                <DataCard
                  key={row.companyId}
                  title={row.companyName}
                  subtitle={`${row.activeUsers} active user${row.activeUsers === 1 ? "" : "s"}`}
                  metric={formatCurrency(row.grossProfitCents ?? 0)}
                  timestamp={row.grossMarginPercent == null ? "No margin yet" : `${row.grossMarginPercent}% margin`}
                >
                  <Link to={`/economics/${row.companyId}?preset=${preset}`} className="table-link">
                    Open detail
                  </Link>
                  <dl className="mobile-record-meta">
                    <div>
                      <dt>Revenue</dt>
                      <dd>{formatCurrency(row.revenueCents)}</dd>
                    </div>
                    <div>
                      <dt>Direct cost</dt>
                      <dd>{formatCurrency(row.directCostCents)}</dd>
                    </div>
                  </dl>
                </DataCard>
              ))}
            </MobileRecordList>
          </div>
          <SectionCard title="Customer profitability" className="desktop-table">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Revenue</th>
                    <th>Direct cost</th>
                    <th>Gross profit</th>
                    <th>Margin</th>
                    <th>Users</th>
                    <th>Cost / user</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((row) => (
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
          </SectionCard>
        </>
      )}
    </>
  );
}
