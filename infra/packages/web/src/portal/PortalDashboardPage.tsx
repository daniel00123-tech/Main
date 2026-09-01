import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { Plug } from "lucide-react";
import {
  buildCustomerActivityFeed,
  buildCustomerAttention,
  connectorOverviewDescription,
  connectorOverviewTitle,
  customerOverallHealthy,
  deriveConnectorCustomerHealth,
  isCustomerConnectedConnector,
  primaryAttentionSummary,
} from "@infra/shared";
import {
  AttentionBanner,
  CollapsibleBlock,
  EmptyState,
  ErrorState,
  KpiStrip,
  LoadingState,
  SectionCard,
  StatusBadge,
  formatCurrency,
  useMediaQuery,
} from "../components";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import { api } from "../api";
import {
  actionCentreBucket,
  formatRelativeTime,
  greetingForNow,
  humanRole,
} from "../lib/format";
import { CompactList, IntegrationRow, PortalPageHeader, ViewAllLink } from "./components";
import { PortalOnboardingChecklist } from "./PortalOnboardingChecklist";
import { ConnectorLogo } from "../components/connectors/ConnectorLogo";
import { usePortalCompany } from "./usePortalCompany";
import { filterCustomerActions } from "../lib/customer-visibility";

export default function PortalDashboardPage() {
  const { company, overview, loading, error, user, membership } = usePortalCompany();
  const [pendingActions, setPendingActions] = useState(0);
  const isMobile = useMediaQuery("(max-width: 900px)");
  const role = membership?.role ?? "office_staff";
  const canSeeBilling =
    role === "company_admin" || role === "director" || user?.isPlatformAdmin;

  useEffect(() => {
    if (!company) return;
    void api.listCompanyActions(company.slug).then((response) => {
      const visible = filterCustomerActions(response.plans, Boolean(user?.isPlatformAdmin));
      setPendingActions(
        visible.filter(
          (plan) =>
            actionCentreBucket(plan.status) === "needs_approval" ||
            actionCentreBucket(plan.status) === "in_progress",
        ).length,
      );
    }).catch(() => setPendingActions(0));
  }, [company, user?.isPlatformAdmin]);

  const base = company ? `/portal/${company.slug}` : "";
  const mcp = overview?.mcpEnvironments[0] ?? null;
  const usage = overview?.usageSummary;
  const wallet = overview?.wallet;
  const connectors = overview?.connectorInstances.filter(isCustomerConnectedConnector) ?? [];
  const testCents = overview?.walletCredits?.testCents ?? 0;
  const paidCents = overview?.walletCredits?.paidCents ?? 0;
  const walletHealth =
    wallet?.walletHealthState ?? (wallet?.lowBalance ? "low" : "healthy");

  const attentionItems = useMemo(() => {
    if (!company || !overview) return [];
    return buildCustomerAttention({
      companyStatus: company.status,
      basePath: base,
      pendingActions,
      walletHealth: walletHealth === "low" ? "low" : walletHealth,
      lowBalance: wallet?.lowBalance ?? false,
      onboardingProblems: overview.onboarding?.problems,
    });
  }, [base, company, overview, pendingActions, wallet?.lowBalance, walletHealth]);

  const attentionForBanner = useMemo(
    () =>
      attentionItems.map(({ id, title, description, to }) => ({
        id,
        title,
        description,
        to,
      })),
    [attentionItems],
  );

  const attentionLead = useMemo(
    () => primaryAttentionSummary(attentionItems),
    [attentionItems],
  );

  const overallHealthy = useMemo(() => {
    if (!company || !overview) return false;
    return customerOverallHealthy({
      companyStatus: company.status,
      attentionItems,
      mcpOnboardingStatus: overview.mcpOnboardingStatus,
    });
  }, [attentionItems, company, overview]);

  const activityFeed = useMemo(
    () => buildCustomerActivityFeed(overview?.recentAuditEvents ?? [], 5),
    [overview?.recentAuditEvents],
  );

  const kpiItems = useMemo(() => {
    if (!overview) return [];
    const all = [
      {
        label: "Connected systems",
        value: String(connectors.length),
        hint: mcp ? "Ready for AI" : "None connected",
        mobile: true,
      },
      {
        label: "Spend this month",
        value: formatCurrency(overview.spendThisMonthCents ?? 0, wallet?.currency ?? "GBP"),
        hint: `${usage?.requestsThisMonth ?? 0} requests`,
        mobile: true,
      },
      {
        label: "Credit balance",
        value: wallet ? formatCurrency(wallet.balanceCents, wallet.currency) : "—",
        hint:
          walletHealth === "healthy"
            ? `Purchased ${formatCurrency(paidCents, wallet?.currency ?? "GBP")}`
            : walletHealth === "empty"
              ? "Empty — add credit"
              : "Low balance",
        mobile: canSeeBilling,
      },
      {
        label: "Users",
        value: String(overview.teamCount ?? 0),
        hint: "Team members",
        mobile: true,
      },
      {
        label: "AI connections",
        value: String(overview.activeAiIdentityCount ?? 0),
        hint: "Active ChatGPT / Claude",
        mobile: false,
      },
      {
        label: "Usage this month",
        value: String(usage?.requestsThisMonth ?? 0),
        hint: `${usage?.successfulThisMonth ?? 0} successful`,
        mobile: false,
      },
    ];
    return isMobile ? all.filter((item) => item.mobile) : all;
  }, [
    canSeeBilling,
    connectors.length,
    isMobile,
    mcp,
    overview,
    paidCents,
    usage,
    wallet,
    walletHealth,
  ]);

  if (loading) return <LoadingState label="Loading your company…" />;
  if (error || !company || !overview || !user) {
    return <ErrorState title="Unable to load dashboard" description={error ?? undefined} />;
  }

  const primaryAction =
    pendingActions > 0 ? (
      <Link to={`${base}/actions`} className="button button-primary">
        Review actions{isMobile ? "" : ` (${pendingActions})`}
      </Link>
    ) : connectors.length === 0 ? (
      <Link to={`${base}/connectors`} className="button button-primary">
        Connect a system
      </Link>
    ) : (
      <Link to={`${base}/chat`} className="button button-primary">
        Open chat
      </Link>
    );

  return (
    <div className="executive-overview">
      <PortalPageHeader
        title={company.name}
        hideTitleOnMobile
        className="portal-overview-header"
        description={`${greetingForNow(user.displayName)} · ${humanRole(membership?.role)}`}
        meta={
          !isMobile || attentionItems.length === 0 ? (
            <StatusBadge
              status={
                overallHealthy
                  ? "healthy"
                  : company.status === "suspended"
                    ? "suspended"
                    : "warning"
              }
              label={
                overallHealthy
                  ? "All systems operational"
                  : company.status === "suspended"
                    ? "Suspended"
                    : "Needs attention"
              }
            />
          ) : null
        }
        actions={!isMobile || pendingActions === 0 ? primaryAction : null}
      />

      <AttentionBanner
        items={attentionForBanner}
        allClear="You're all caught up"
        compact={isMobile}
        primaryAction={
          attentionLead?.to && attentionLead.actionLabel
            ? { label: attentionLead.actionLabel, to: attentionLead.to }
            : undefined
        }
      />

      <PortalOnboardingChecklist />

      <div className="grid grid-2 portal-overview-panels">
        <SectionCard
          title="Connected systems"
          className="portal-panel-compact"
          actions={<ViewAllLink to={`${base}/connectors`} />}
        >
          {connectors.length === 0 ? (
            <EmptyState
              icon={<Plug size={24} />}
              title="Connect your first business system"
              description="Link accounting, documents, or field service tools so INFRA can help your team."
              action={
                <Link to={`${base}/connectors`} className="button button-primary">
                  Browse connections
                </Link>
              }
            />
          ) : (
            <CompactList className="portal-integration-list">
              {connectors.slice(0, 5).map((item) => {
                const health = deriveConnectorCustomerHealth(item);
                return (
                  <IntegrationRow
                    key={item.id}
                    compact={isMobile}
                    icon={
                      <ConnectorLogo
                        slug={item.connectorDefinitionId.replace("conn_", "").replace(/_/g, "-")}
                        name={item.name}
                      />
                    }
                    name={connectorOverviewTitle({
                      connectorDefinitionId: item.connectorDefinitionId,
                      name: item.name,
                      displayAccountName: item.displayAccountName,
                      companyName: company.name,
                    })}
                    purpose={connectorOverviewDescription(item.connectorDefinitionId)}
                    status={health.badgeStatus}
                    statusLabel={health.label}
                  />
                );
              })}
            </CompactList>
          )}
        </SectionCard>

        <SectionCard
          title="Recent activity"
          className="portal-panel-compact"
          actions={<ViewAllLink to={`${base}/activity`} />}
        >
          {activityFeed.length === 0 ? (
            <EmptyState title="No recent activity" description="Important company changes will appear here." />
          ) : (
            <CompactList className="portal-integration-list">
              {activityFeed.map((item) => (
                <IntegrationRow
                  key={item.id}
                  compact={isMobile}
                  name={item.title}
                  purpose={item.description}
                  status={item.tone === "danger" ? "error" : item.tone === "warning" ? "warning" : "healthy"}
                  statusLabel={formatRelativeTime(item.createdAt)}
                />
              ))}
            </CompactList>
          )}
        </SectionCard>
      </div>

      <KpiStrip items={kpiItems} className="portal-kpi-strip" />

      {overview.onboarding && !overview.onboarding.readyForUse && !isMobile ? (
        <CollapsibleBlock
          title="Setup checklist"
          summary={<StatusBadge status="warning" label="Incomplete" />}
        >
          <OnboardingChecklist onboarding={overview.onboarding} />
        </CollapsibleBlock>
      ) : null}

      {canSeeBilling && (testCents > 0 || paidCents > 0) && !isMobile ? (
        <CollapsibleBlock title="Credit breakdown" summary="Wallet details">
          <div className="kv-stack">
            <div className="drawer-row">
              <dt>Promotional / test credit</dt>
              <dd>{formatCurrency(testCents, wallet?.currency ?? "GBP")}</dd>
            </div>
            <div className="drawer-row">
              <dt>Paid credit</dt>
              <dd>{formatCurrency(paidCents, wallet?.currency ?? "GBP")}</dd>
            </div>
            <p className="muted small" style={{ margin: "8px 0 0" }}>
              Usage draws from your pooled balance. Credit type is tracked for reporting only.
            </p>
          </div>
        </CollapsibleBlock>
      ) : null}
    </div>
  );
}
