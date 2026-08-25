import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Network, Plug, ShieldAlert } from "lucide-react";
import type { Company } from "@infra/shared";
import { api } from "../api";
import {
  ActivityFeed,
  AttentionBanner,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  MetricGrid,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";
import {
  formatCharge,
  formatNumber,
  formatRelativeTime,
  humanEventLabel,
  humanOperation,
} from "../lib/format";

export default function DashboardPage() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.getSummary>> | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [balances, setBalances] = useState<Awaited<ReturnType<typeof api.getBillingBalances>>>([]);
  const [attentionItems, setAttentionItems] = useState<
    Awaited<ReturnType<typeof api.getPlatformAttention>>["items"]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, companyList, balanceList, attentionData] = await Promise.all([
        api.getSummary(),
        api.getCompanies(),
        api.getBillingBalances().catch(() => []),
        api.getPlatformAttention().catch(() => ({ items: [], checkedAt: "" })),
      ]);
      setSummary(summaryData);
      setCompanies(companyList);
      setBalances(balanceList);
      setAttentionItems(attentionData.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const attention = useMemo(
    () =>
      attentionItems.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.companyName ? `${item.companyName} — ${item.detail}` : item.detail,
        to: item.href ?? undefined,
      })),
    [attentionItems],
  );

  if (loading) return <LoadingState label="Loading control plane…" />;
  if (error || !summary) {
    return <ErrorState title="Unable to load dashboard" description={error ?? undefined} onRetry={() => void load()} />;
  }

  const companyById = new Map(companies.map((c) => [c.id, c]));

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Operational command centre for companies, integrations, and AI gateways."
      />

      <AttentionBanner items={attention} allClear="No platform alerts" />

      <MetricGrid cols={4}>
        <MetricCard
          label="Companies"
          value={formatNumber(summary.companies)}
          hint="Organisations on INFRA"
          icon={<Building2 size={16} />}
          to="/companies"
        />
        <MetricCard
          label="Active connectors"
          value={formatNumber(summary.activeConnectors)}
          hint={`${formatNumber(summary.connectorInstances)} total instances`}
          icon={<Plug size={16} />}
          to="/connectors"
        />
        <MetricCard
          label="Healthy gateways"
          value={`${formatNumber(summary.healthyMcp)} / ${formatNumber(summary.mcpEnvironments)}`}
          hint="AI gateway environments"
          icon={<Network size={16} />}
          to="/mcp-environments"
        />
        <MetricCard
          label="Attention"
          value={formatNumber(attention.length)}
          hint={attention.length === 0 ? "Nothing pending" : "Needs review"}
          icon={<ShieldAlert size={16} />}
          to="/companies"
        />
      </MetricGrid>

      <div style={{ marginTop: 16 }}>
        <MetricGrid cols={4}>
          <MetricCard
            label="Onboarding"
            value={formatNumber(summary.onboardingCompanies ?? 0)}
            hint="Companies still being set up"
            to="/companies"
          />
          <MetricCard
            label="Usage today"
            value={formatNumber(summary.usageToday ?? 0)}
            hint={`${formatNumber(summary.usageThisMonth ?? 0)} this month`}
            to="/usage"
          />
          <MetricCard
            label="Active AI identities"
            value={formatNumber(summary.activeAiIdentities ?? 0)}
            hint="Service tokens currently active"
            to="/ai-clients"
          />
          <MetricCard
            label="Low wallets"
            value={formatNumber(summary.lowBalanceCompanies ?? 0)}
            hint="Below alert threshold"
            to="/billing"
          />
        </MetricGrid>
      </div>

      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <SectionCard
          title="Companies"
          description="Jump into a company control centre."
          actions={
            <Link to="/companies" className="button button-ghost button-small">
              View all
            </Link>
          }
        >
          {companies.length === 0 ? (
            <EmptyState
              title="No companies yet"
              description="Create a company record from the Companies screen."
            />
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Status</th>
                    <th>Domain</th>
                  </tr>
                </thead>
                <tbody>
                  {companies.slice(0, 6).map((company) => (
                    <tr key={company.id}>
                      <td>
                        <Link to={`/companies/${company.slug}`}>{company.name}</Link>
                      </td>
                      <td>
                        <StatusBadge status={company.status} />
                      </td>
                      <td className="muted">{company.primaryDomain ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Recent activity" description="Human-readable platform events.">
          <ActivityFeed
            items={summary.recentAuditEvents.slice(0, 8).map((event) => {
              const company = event.companyId ? companyById.get(event.companyId) : undefined;
              return {
                id: event.id,
                title: humanEventLabel(event.eventType),
                description: [company?.name, event.actor].filter(Boolean).join(" · ") || undefined,
                meta: formatRelativeTime(event.createdAt),
                status: typeof event.detail?.result === "string" ? String(event.detail.result) : undefined,
              };
            })}
          />
        </SectionCard>
      </div>

      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <SectionCard
          title="Recent usage"
          description={
            summary.permissionDenialsLast24h
              ? `${summary.permissionDenialsLast24h} permission denials in the last 24 hours`
              : "Latest operations across companies"
          }
          actions={
            <Link to="/usage" className="button button-ghost button-small">
              View usage
            </Link>
          }
        >
          {!summary.recentUsage || summary.recentUsage.length === 0 ? (
            <EmptyState
              title="No usage yet"
              description="Usage appears after an AI client calls INFRA."
            />
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Operation</th>
                    <th className="num">Charge</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.recentUsage.slice(0, 6).map((row) => (
                    <tr key={row.id}>
                      <td>{formatRelativeTime(row.recordedAt)}</td>
                      <td>{humanOperation(row.action, row.toolName)}</td>
                      <td className="num">{formatCharge(row.customerChargeCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
        <SectionCard title="Wallet alerts" description="Companies below their low-balance threshold.">
          {balances.filter((b) => b.lowBalance).length === 0 ? (
            <EmptyState title="No low wallets" description="Every company is above its alert threshold." />
          ) : (
            <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
              {balances
                .filter((b) => b.lowBalance)
                .map((b) => (
                  <li key={b.companyId}>
                    <Link to={`/companies/${b.companySlug}`}>{b.companyName}</Link>
                  </li>
                ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}
