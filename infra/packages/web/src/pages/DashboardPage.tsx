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
import { useAdminScope } from "../context/AdminScopeContext";
import {
  ActivityFeed,
  CollapsibleBlock,
  EmptyState,
  ErrorState,
  LoadingState,
  MobileRecordCard,
  MobileRecordList,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
  useIsMobile,
} from "../components";
import {
  adminDashboardOperationSummary,
  permissionDenialOperatorSummary,
} from "../lib/admin-present";
import {
  formatCharge,
  formatNumber,
  formatRelativeTime,
  humanActor,
  humanEventLabel,
} from "../lib/format";

export default function DashboardPage() {
  const { companyId: scopeCompanyId, companySlug: scopeCompanySlug } = useAdminScope();
  const isMobile = useIsMobile();
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
      attentionItems
        .filter((item) => !scopeCompanyId || item.companyId === scopeCompanyId)
        .map((item) => ({
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
    [attentionItems, scopeCompanyId],
  );

  const scopedCompanies = useMemo(
    () =>
      scopeCompanySlug
        ? companies.filter((c) => c.slug === scopeCompanySlug)
        : companies,
    [companies, scopeCompanySlug],
  );

  const scopedRecentUsage = useMemo(
    () =>
      scopeCompanyId
        ? (summary?.recentUsage ?? []).filter((r) => r.companyId === scopeCompanyId)
        : summary?.recentUsage ?? [],
    [summary?.recentUsage, scopeCompanyId],
  );

  async function dismissItem(item: { id: string; severity: "critical" | "warning" | "info" }) {
    try {
      await api.dismissAttention({ attentionKey: item.id, severity: item.severity });
      setAttentionItems((prev) => prev.filter((a) => a.id !== item.id || a.severity === "critical"));
    } catch {
      /* keep item visible */
    }
  }

  if (loading) return <LoadingState label="Loading admin control panel…" />;
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
  const activeCompanies = scopedCompanies.filter((c) => c.status === "active").length;
  const lowWallets = balances.filter((b) => b.lowBalance).length;
  const platformHealthy =
    summary.mcpEnvironments === 0
      ? "No gateways"
      : summary.healthyMcp === summary.mcpEnvironments
        ? "Healthy"
        : "Needs review";
  const denialSummary = permissionDenialOperatorSummary(summary.permissionDenialsLast24h ?? 0);
  const spendThisMonth = summary.recentUsage?.reduce((sum, row) => sum + (row.customerChargeCents ?? 0), 0) ?? 0;

  const companiesSection = scopedCompanies.length === 0 ? (
    <EmptyState
      title="No companies yet"
      description="Create a company record from the Companies screen."
    />
  ) : isMobile ? (
    <MobileRecordList>
      {scopedCompanies.slice(0, 6).map((company) => (
        <MobileRecordCard key={company.id}>
          <Link to={`/companies/${company.slug}`} className="mobile-record-title table-link">
            {company.name}
          </Link>
          <div className="mobile-record-meta-inline">
            <StatusBadge status={company.status} />
          </div>
        </MobileRecordCard>
      ))}
    </MobileRecordList>
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
          {scopedCompanies.slice(0, 6).map((company) => (
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
  );

  const recentUsageSection =
    !scopedRecentUsage || scopedRecentUsage.length === 0 ? (
      <EmptyState title="No usage yet" description="Usage appears after an AI client calls INFRA." />
    ) : isMobile ? (
      <MobileRecordList>
        {scopedRecentUsage.slice(0, 5).map((row) => (
          <MobileRecordCard key={row.id}>
            <div className="mobile-record-header">
              <strong>{adminDashboardOperationSummary(row.action, row.toolName)}</strong>
              <span className="muted small">{formatRelativeTime(row.recordedAt)}</span>
            </div>
            <div className="muted small">
              {formatCharge(row.customerChargeCents)}
              {row.companyId && companyById.get(row.companyId)?.name
                ? ` · ${companyById.get(row.companyId)?.name}`
                : ""}
            </div>
          </MobileRecordCard>
        ))}
      </MobileRecordList>
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
            {scopedRecentUsage.slice(0, 6).map((row) => (
              <tr key={row.id}>
                <td>{formatRelativeTime(row.recordedAt)}</td>
                <td>{adminDashboardOperationSummary(row.action, row.toolName)}</td>
                <td className="num">{formatCharge(row.customerChargeCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          isMobile
            ? "Platform health and operator actions at a glance."
            : "Executive control centre for platform health, customers, usage, and commercial activity."
        }
      />

      {isMobile ? (
        <div className="admin-platform-summary card">
          <div className="admin-platform-summary-row">
            <span className="muted small">Platform</span>
            <strong>{platformHealthy}</strong>
          </div>
          <div className="admin-platform-summary-row">
            <span className="muted small">Companies</span>
            <strong>{formatNumber(activeCompanies)} active</strong>
          </div>
          <div className="admin-platform-summary-row">
            <span className="muted small">Connectors</span>
            <strong>
              {formatNumber(summary.activeConnectors)} healthy
              {summary.connectorInstances > summary.activeConnectors
                ? ` / ${formatNumber(summary.connectorInstances - summary.activeConnectors)} attention`
                : ""}
            </strong>
          </div>
          <div className="admin-platform-summary-row">
            <span className="muted small">Usage</span>
            <strong>{formatNumber(summary.usageThisMonth ?? 0)} this month</strong>
          </div>
          <div className="admin-platform-summary-row">
            <span className="muted small">Issues</span>
            <strong>{formatNumber(attention.length)} need review</strong>
          </div>
        </div>
      ) : (
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
      )}

      <div style={{ marginTop: isMobile ? 12 : 20 }}>
        <AttentionCentre
          items={attention}
          onDismiss={(item) => void dismissItem(item)}
          allClear="No platform alerts"
        />
      </div>

      {isMobile ? (
        <div className="admin-dashboard-collapsibles">
          <CollapsibleBlock
            title="Companies"
            summary={`${formatNumber(activeCompanies)} active`}
          >
            {companiesSection}
            <p style={{ marginTop: 12 }}>
              <Link to="/companies" className="button button-ghost button-small">
                View all companies
              </Link>
            </p>
          </CollapsibleBlock>

          <CollapsibleBlock title="Recent activity" summary="Latest platform events">
            <ActivityFeed
              items={summary.recentAuditEvents.slice(0, 6).map((event) => {
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
          </CollapsibleBlock>

          <CollapsibleBlock
            title="Recent usage"
            summary={`${formatNumber(summary.usageThisMonth ?? 0)} requests · ${formatCharge(spendThisMonth)}`}
          >
            <p className={`muted small${denialSummary.reviewRecommended ? " usage-summary-warn" : ""}`}>
              {denialSummary.headline}. {denialSummary.detail}
            </p>
            {recentUsageSection}
            <p style={{ marginTop: 12 }}>
              <Link to="/usage" className="button button-ghost button-small">
                View usage
              </Link>
            </p>
          </CollapsibleBlock>
        </div>
      ) : (
        <>
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
              {companiesSection}
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
              description={`${denialSummary.headline}. ${denialSummary.detail}`}
              actions={
                <Link to="/usage" className="button button-ghost button-small">
                  View usage
                </Link>
              }
            >
              {recentUsageSection}
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
                <div className={`secondary-metric${denialSummary.reviewRecommended ? " usage-summary-warn" : ""}`}>
                  <AlertTriangle size={14} aria-hidden />
                  <span>
                    Permission blocks (24h):{" "}
                    <strong>{formatNumber(summary.permissionDenialsLast24h ?? 0)}</strong>
                  </span>
                </div>
              </div>
            </SectionCard>
          </div>
        </>
      )}
    </>
  );
}
