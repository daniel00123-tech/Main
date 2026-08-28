import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import {
  connectorOverviewDescription,
  connectorOverviewTitle,
  deriveConnectorCustomerHealth,
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
} from "../components";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import { api } from "../api";
import {
  actionCentreBucket,
  formatRelativeTime,
  greetingForNow,
  humanActor,
  humanEventLabel,
  humanRole,
} from "../lib/format";
import { CompactList, IntegrationRow, PortalPageHeader, ViewAllLink } from "./components";
import { PortalOnboardingChecklist } from "./PortalOnboardingChecklist";
import { ConnectorLogo } from "../components/connectors/ConnectorLogo";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalDashboardPage() {
  const { company, overview, loading, error, user, membership } = usePortalCompany();
  const [pendingActions, setPendingActions] = useState(0);

  useEffect(() => {
    if (!company) return;
    void api.listCompanyActions(company.slug).then((response) => {
      setPendingActions(
        response.plans.filter(
          (plan) =>
            actionCentreBucket(plan.status) === "needs_approval" ||
            actionCentreBucket(plan.status) === "in_progress",
        ).length,
      );
    }).catch(() => setPendingActions(0));
  }, [company]);

  if (loading) return <LoadingState label="Loading your company…" />;
  if (error || !company || !overview || !user) {
    return <ErrorState title="Unable to load dashboard" description={error ?? undefined} />;
  }

  const base = `/portal/${company.slug}`;
  const mcp = overview.mcpEnvironments[0] ?? null;
  const usage = overview.usageSummary;
  const wallet = overview.wallet;
  const connectors = overview.connectorInstances.filter((c) => c.status !== "draft");
  const testCents = overview.walletCredits?.testCents ?? 0;
  const paidCents = overview.walletCredits?.paidCents ?? 0;
  const lowBalance = wallet?.lowBalance ?? false;
  const spendThisMonthCents = overview.spendThisMonthCents ?? 0;
  const walletHealth =
    wallet?.walletHealthState ?? (wallet?.lowBalance ? "low" : "healthy");

  const attention: Array<{ id: string; title: string; description?: string; to?: string }> = [];

  if (company.status === "suspended") {
    attention.push({
      id: "suspended",
      title: "Company is suspended",
      description: "Paid AI operations and connector writes are blocked.",
      to: `${base}/settings`,
    });
  }
  if (lowBalance || walletHealth === "critical" || walletHealth === "empty") {
    attention.push({
      id: "low-balance",
      title:
        walletHealth === "empty"
          ? "No credit remaining"
          : walletHealth === "critical"
            ? "Very low credit"
            : "Low credit",
      description: "Add credit to avoid interrupted AI usage.",
      to: `${base}/billing`,
    });
  }
  if (pendingActions > 0) {
    attention.push({
      id: "pending-actions",
      title: `${pendingActions} action${pendingActions === 1 ? "" : "s"} need attention`,
      description: "Review and approve planned financial actions.",
      to: `${base}/actions`,
    });
  }
  for (const item of overview.onboarding?.problems ?? []) {
    attention.push({
      id: item.id,
      title: item.title,
      description: item.detail,
      to: item.href ?? undefined,
    });
  }

  const overallHealthy =
    company.status === "active" &&
    attention.filter((a) => a.id !== "suspended").length === 0 &&
    (overview.mcpOnboardingStatus === "healthy" || overview.mcpOnboardingStatus === "registered");

  const recentEvents = overview.recentAuditEvents.slice(0, 5);

  return (
    <div className="executive-overview">
      <PortalPageHeader
        title={company.name}
        hideTitleOnMobile
        className="portal-overview-header"
        description={`${greetingForNow(user.displayName)} · ${humanRole(membership?.role)}`}
        meta={
          <StatusBadge
            status={overallHealthy ? "healthy" : company.status === "suspended" ? "suspended" : "warning"}
            label={overallHealthy ? "All systems operational" : company.status === "suspended" ? "Suspended" : "Needs attention"}
          />
        }
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {connectors.length === 0 ? (
              <Link to={`${base}/connectors`} className="button button-primary">
                Connect a system
              </Link>
            ) : pendingActions > 0 ? (
              <Link to={`${base}/actions`} className="button button-primary">
                Review actions ({pendingActions})
              </Link>
            ) : (
              <Link to={`${base}/usage`} className="button button-secondary">
                View usage
              </Link>
            )}
          </div>
        }
      />

      <AttentionBanner items={attention} allClear="You're all caught up" />

      <PortalOnboardingChecklist />

      <KpiStrip
        items={[
          {
            label: "Connected systems",
            value: String(connectors.length),
            hint: mcp ? "AI connection ready" : "None connected",
          },
          {
            label: "AI connections",
            value: String(overview.activeAiIdentityCount ?? 0),
            hint: "Active ChatGPT / Claude",
          },
          {
            label: "Spend this month",
            value: formatCurrency(spendThisMonthCents, wallet?.currency ?? "GBP"),
            hint: `${usage?.requestsThisMonth ?? 0} requests`,
          },
          {
            label: "Usage this month",
            value: String(usage?.requestsThisMonth ?? 0),
            hint: `${usage?.successfulThisMonth ?? 0} successful`,
          },
          {
            label: "Credit balance",
            value: wallet ? formatCurrency(wallet.balanceCents, wallet.currency) : "—",
            hint:
              walletHealth === "healthy"
                ? `Paid ${formatCurrency(paidCents, wallet?.currency ?? "GBP")}`
                : walletHealth === "empty"
                  ? "Empty — add credit"
                  : "Low balance",
          },
          {
            label: "Users",
            value: String(overview.teamCount ?? 0),
            hint: "Team members",
          },
          {
            label: "Actions",
            value: String(pendingActions),
            hint: pendingActions > 0 ? "Need attention" : "None pending",
          },
        ]}
      />

      <div className="grid grid-2">
        <SectionCard
          title="Connected systems"
          actions={<ViewAllLink to={`${base}/connectors`} />}
        >
          {connectors.length === 0 && !mcp ? (
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
            <CompactList>
              {connectors.slice(0, 5).map((item) => {
                const health = deriveConnectorCustomerHealth(item);
                return (
                <IntegrationRow
                  key={item.id}
                  icon={<ConnectorLogo slug={item.connectorDefinitionId.replace("conn_", "").replace(/_/g, "-")} name={item.name} />}
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
              {mcp && connectors.length === 0 ? (
                <IntegrationRow
                  name="AI connection"
                  purpose="Connect ChatGPT or Claude to your company systems"
                  status={overview.mcpOnboardingStatus ?? mcp.status}
                />
              ) : null}
            </CompactList>
          )}
        </SectionCard>

        <SectionCard title="Recent activity" actions={<ViewAllLink to={`${base}/activity`} />}>
          {recentEvents.length === 0 ? (
            <EmptyState title="No activity yet" description="Company changes will appear here." />
          ) : (
            <CompactList>
              {recentEvents.map((event) => (
                <IntegrationRow
                  key={event.id}
                  name={humanEventLabel(event.eventType)}
                  purpose={humanActor(event.actor)}
                  status="healthy"
                  statusLabel={formatRelativeTime(event.createdAt)}
                />
              ))}
            </CompactList>
          )}
        </SectionCard>
      </div>

      {overview.onboarding ? (
        <CollapsibleBlock
          title="Setup checklist"
          summary={
            overview.onboarding.readyForUse ? (
              <StatusBadge status="healthy" label="Ready" />
            ) : (
              <StatusBadge status="warning" label="Incomplete" />
            )
          }
        >
          <OnboardingChecklist onboarding={overview.onboarding} />
        </CollapsibleBlock>
      ) : null}

      {(testCents > 0 || paidCents > 0) && (
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
      )}
    </div>
  );
}