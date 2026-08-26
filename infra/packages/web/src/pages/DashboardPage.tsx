import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Building2,
  Network,
  TrendingUp,
  Wallet,
} from "lucide-react";
import type { Company } from "@infra/shared";
import { api } from "../api";
import AttentionCentre from "../components/AttentionCentre";
import {
  ActivityFeed,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
} from "../components";
import {
  formatCharge,
  formatNumber,
  formatRelativeTime,
  humanActor,
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
        severity: item.severity,
        title: item.title,
        detail: item.detail,
        companyName: item.companyName,
        href: item.href ?? undefined,
        recommendedAction:
          item.severity === "critical"
            ? "Resolve before dismissing"
            : item.category === "wallet"
              ? "Review billing and top up if needed"
              : item.category === "ai_identity"
                ? "Create an AI connection in the company portal"
                : "Review and take action",
      })),
    [attentionItems],
  );

  async function dismissItem(item: { id: string; severity: "critical" | "warning" | "info" }) {
    try {
      await api.dismissAttention({ attentionKey: item.id, severity: item.severity });
      setAttentionItems((prev) => prev.filter((a) => a.id !== item.id || a.severity === "critical"));
    } catch {
      /* keep item visible */
    }
  }

  if (loading) return <LoadingState label="Loading control plane…" />;
  if (error || !summary) {
    return (
      <ErrorState
        title="Unable to load dashboard"
        description={error ?? undefined}
        onRetry={() => void load()}
      />
    );
  }

  const companyById = new Map(companies.map((c) => [c.id, c]));
  const activeCompanies = companies.filter((c) => c.status === "active").length;
  const lowWallets = balances.filter((b) => b.lowBalance).length;
  const platformHealthy =
    summary.mcpEnvironments === 0
      ? "No gateways"
      : summary.healthyMcp === summary.mcpEnvironments
        ? "Healthy"
        : "Needs review";

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Executive control centre for platform health, customers, usage, and commercial activity."
      />

      <div className="executive-pillars">
        <Link to="/mcp-environments" className="executive-pillar card">
          <div className="executive-pillar-icon">
            <Network size={18} />
          </div>
          <div className="executive-pillar-body">
            <span className="executive-pillar-label">Platform health</span>
            <strong className="executive-pillar-value">{platformHealthy}</strong>
            <span className="muted small">
              {formatNumber(summary.healthyMcp)}/{formatNumber(summary.mcpEnvironments)} gateways ·{" "}
              {formatNumber(summary.activeConnectors)} active connectors
            </span>
          </div>
        </Link>

        <Link to="/companies" className="executive-pillar card">
          <div className="executive-pillar-icon">
            <Building2 size={18} />
          </div>
          <div className="executive-pillar-body">
            <span className="executive-pillar-label">Customers</span>
            <strong className="executive-pillar-value">{formatNumber(activeCompanies)} active</strong>
            <span className="muted small">
              {formatNumber(summary.companies)} total · {formatNumber(summary.onboardingCompanies ?? 0)}{" "}
              onboarding
            </span>
          </div>
        </Link>

        <Link to="/usage" className="executive-pillar card">
          <div className="executive-pillar-icon">
            <Activity size={18} />
          </div>
          <div className="executive-pillar-body">
            <span className="executive-pillar-label">Usage</span>
            <strong className="executive-pillar-value">
              {formatNumber(summary.usageThisMonth ?? 0)} this month
            </strong>
            <span className="muted small">
              {formatNumber(summary.usageToday ?? 0)} today ·{" "}
              {formatNumber(summary.activeAiIdentities ?? 0)} AI identities
            </span>
          </div>
        </Link>

        <Link to="/billing" className="executive-pillar card">
          <div className="executive-pillar-icon">
            <Wallet size={18} />
          </div>
          <div className="executive-pillar-body">
            <span className="executive-pillar-label">Commercial</span>
            <strong className="executive-pillar-value">
              {summary.totalWalletCents != null
                ? formatCurrency(summary.totalWalletCents)
                : "—"}
            </strong>
            <span className="muted small">
              {lowWallets > 0
                ? `${formatNumber(lowWallets)} low wallet${lowWallets === 1 ? "" : "s"}`
                : "Wallet balances healthy"}
            </span>
          </div>
        </Link>

        <Link to="/companies?filter=attention" className="executive-pillar card">
          <div className="executive-pillar-icon executive-pillar-icon-warn">
            <AlertTriangle size={18} />
          </div>
          <div className="executive-pillar-body">
            <span className="executive-pillar-label">Attention</span>
            <strong className="executive-pillar-value">{formatNumber(attention.length)}</strong>
            <span className="muted small">
              {attention.length === 0 ? "Nothing pending" : "Items need review"}
            </span>
          </div>
        </Link>
      </div>

      <div style={{ marginTop: 20 }}>
        <AttentionCentre
          items={attention}
          onDismiss={(item) => void dismissItem(item)}
          allClear="No platform alerts"
        />
      </div>

      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <SectionCard
          title="Companies"
          description="Open a company control centre."
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
                        <Link to={`/companies/${company.slug}`} className="table-link">
                          {company.name}
                        </Link>
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

        <SectionCard title="Recent activity" description="Who did what, when.">
          <ActivityFeed
            items={summary.recentAuditEvents.slice(0, 8).map((event) => {
              const company = event.companyId ? companyById.get(event.companyId) : undefined;
              const actor = humanActor(event.actor);
              const result =
                typeof event.detail?.result === "string" ? String(event.detail.result) : undefined;
              return {
                id: event.id,
                title: actor,
                description: [
                  humanEventLabel(event.eventType),
                  company?.name,
                  result && result !== "ok" ? result : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                meta: formatRelativeTime(event.createdAt),
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
        <SectionCard
          title="Secondary metrics"
          description="Operational detail — expand from pillar cards above."
        >
          <div className="secondary-metrics">
            <div className="secondary-metric">
              <TrendingUp size={14} aria-hidden />
              <span>
                Onboarding: <strong>{formatNumber(summary.onboardingCompanies ?? 0)}</strong>
              </span>
            </div>
            <div className="secondary-metric">
              <Network size={14} aria-hidden />
              <span>
                Connector instances: <strong>{formatNumber(summary.connectorInstances)}</strong>
              </span>
            </div>
            <div className="secondary-metric">
              <AlertTriangle size={14} aria-hidden />
              <span>
                Permission denials (24h):{" "}
                <strong>{formatNumber(summary.permissionDenialsLast24h ?? 0)}</strong>
              </span>
            </div>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
