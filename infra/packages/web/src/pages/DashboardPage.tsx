import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Network, Plug, ShieldAlert } from "lucide-react";
import type { Company, McpEnvironment } from "@infra/shared";
import { api } from "../api";
import {
  ActivityFeed,
  AttentionBanner,
  ErrorState,
  LoadingState,
  MetricCard,
  MetricGrid,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";
import {
  formatNumber,
  formatRelativeTime,
  humanEventLabel,
} from "../lib/format";

export default function DashboardPage() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.getSummary>> | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [mcps, setMcps] = useState<McpEnvironment[]>([]);
  const [balances, setBalances] = useState<Awaited<ReturnType<typeof api.getBillingBalances>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, companyList, mcpList, balanceList] = await Promise.all([
        api.getSummary(),
        api.getCompanies(),
        api.getMcpEnvironments(),
        api.getBillingBalances().catch(() => []),
      ]);
      setSummary(summaryData);
      setCompanies(companyList);
      setMcps(mcpList);
      setBalances(balanceList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const attention = useMemo(() => {
    const items: Array<{ id: string; title: string; description?: string; to?: string }> = [];
    for (const mcp of mcps) {
      if (mcp.status === "unreachable" || mcp.status === "degraded") {
        const company = companies.find((c) => c.id === mcp.companyId);
        items.push({
          id: `mcp-${mcp.id}`,
          title: mcp.status === "degraded" ? `${mcp.name} degraded` : `${mcp.name} unavailable`,
          description: company?.name,
          to: "/mcp-environments",
        });
      }
    }
    for (const bal of balances) {
      if (bal.lowBalance) {
        items.push({
          id: `bal-${bal.companyId}`,
          title: `Low credit — ${bal.companyName}`,
          description: "Top up recommended",
          to: `/companies/${bal.companySlug}`,
        });
      }
    }
    return items;
  }, [mcps, companies, balances]);

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

      <AttentionBanner items={attention} allClear="All systems operational" />

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
        />
      </MetricGrid>

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
            <p className="muted">No companies yet.</p>
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
    </>
  );
}
