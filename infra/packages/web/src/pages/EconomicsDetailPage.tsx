import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import {
  ErrorState,
  LoadingState,
  MetricCard,
  MetricGrid,
  Notice,
  PageHeader,
  SectionCard,
  formatCurrency,
} from "../components";

export default function EconomicsDetailPage() {
  const { companyId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const preset = searchParams.get("preset") ?? "current_month";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getCompanyEconomics>> | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getCompanyEconomics(companyId, { preset }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load customer detail");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [companyId, preset]);

  if (loading) return <LoadingState label="Loading customer economics…" />;
  if (error || !data?.company) {
    return <ErrorState title="Unable to load customer" description={error ?? "Not found"} onRetry={() => void load()} />;
  }

  const company = data.company;

  return (
    <>
      <PageHeader
        title={company.companyName}
        description="Direct customer economics. Unattributed cost stays at company level."
        actions={
          <Link to="/economics" className="muted small">
            ← All customers
          </Link>
        }
      />
      <Notice tone="info">{company.cashBasisNote}</Notice>
      <MetricGrid>
        <MetricCard label="Revenue" value={formatCurrency(company.revenueCents)} />
        <MetricCard label="Direct cost" value={formatCurrency(company.directCostCents)} />
        <MetricCard label="Gross profit" value={formatCurrency(company.grossProfitCents ?? 0)} />
        <MetricCard
          label="Gross margin"
          value={company.grossMarginPercent == null ? "—" : `${company.grossMarginPercent}%`}
        />
        <MetricCard label="Cash collected" value={formatCurrency(company.cashCollectedCents)} />
        <MetricCard label="Active users" value={String(company.activeUsers)} />
        <MetricCard label="OCR cost" value={formatCurrency(company.ocrCostCents)} />
        <MetricCard label="Stripe fees (est.)" value={formatCurrency(company.stripeFeeCents)} />
      </MetricGrid>

      <SectionCard title="Cost by provider">
        {data.providers.length === 0 ? (
          <p className="muted">No attributable provider cost in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Service</th>
                  <th>Basis</th>
                  <th>Events</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((row) => (
                  <tr key={`${row.provider}-${row.service}`}>
                    <td>{row.provider}</td>
                    <td>{row.service}</td>
                    <td>{row.costBasis}</td>
                    <td>{row.eventCount}</td>
                    <td>{formatCurrency(row.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Revenue vs cost over time">
        {data.trend.length === 0 ? (
          <p className="muted">No daily activity in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Revenue</th>
                  <th>Direct cost</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.map((row) => (
                  <tr key={row.day}>
                    <td>{row.day}</td>
                    <td>{formatCurrency(row.revenueCents)}</td>
                    <td>{formatCurrency(row.directCostCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="User breakdown">
        {data.users.length === 0 ? (
          <p className="muted">No usage in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Attributed</th>
                  <th>Usage</th>
                  <th>Interactions</th>
                  <th>Charge</th>
                  <th>Cost</th>
                  <th>Features</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((row) => (
                  <tr key={row.userId ?? row.actorLabel}>
                    <td>{row.actorLabel}</td>
                    <td>{row.attributed ? "Yes" : "Company-level"}</td>
                    <td>{row.usageCount}</td>
                    <td>{row.interactionCount}</td>
                    <td>{formatCurrency(row.usageChargeCents)}</td>
                    <td>{formatCurrency(row.directCostCents)}</td>
                    <td className="muted small">{row.features.join(", ") || "—"}</td>
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
