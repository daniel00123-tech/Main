import { Link } from "react-router-dom";
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
  formatCurrency,
} from "../components";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import { formatRelativeTime, greetingForNow, humanEventLabel } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalDashboardPage() {
  const { company, overview, loading, error, user, membership } = usePortalCompany();

  if (loading) return <LoadingState label="Loading your company…" />;
  if (error || !company || !overview || !user) {
    return <ErrorState title="Unable to load dashboard" description={error ?? undefined} />;
  }

  const base = `/portal/${company.slug}`;
  const mcp = overview.mcpEnvironments[0] ?? null;
  const usage = overview.usageSummary;
  const wallet = overview.wallet;
  const connectors = overview.connectorInstances;
  const activeConnectors = connectors.filter(
    (item) => item.status !== "disabled" && item.status !== "draft",
  );
  const attention = (overview.onboarding?.problems ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    description: item.detail,
    to: item.href ?? undefined,
  }));
  if (company.status === "suspended") {
    attention.unshift({
      id: "suspended",
      title: "Company is suspended",
      description: "Paid AI operations are blocked. Contact a platform administrator.",
      to: `${base}/settings`,
    });
  }

  return (
    <>
      <PageHeader
        title={greetingForNow(user.displayName)}
        description={`${company.name} · ${membership?.role ? membership.role.replace(/_/g, " ") : "member"}`}
        meta={<StatusBadge status={company.status} />}
      />

      <AttentionBanner items={attention} allClear="No alerts right now" />

      <SectionCard
        title="Onboarding"
        description="What exists, what does not, and what still needs to happen."
      >
        {overview.onboarding ? (
          <OnboardingChecklist onboarding={overview.onboarding} />
        ) : (
          <p className="muted">Onboarding state is not available yet.</p>
        )}
      </SectionCard>

      <MetricGrid cols={4}>
        <MetricCard
          label="Business MCP"
          value={
            <StatusBadge
              status={overview.mcpOnboardingStatus ?? "not_provisioned"}
              label={mcp ? undefined : "Not provisioned"}
            />
          }
          hint={mcp ? mcp.name : "Register an existing MCP from Platform Admin"}
        />
        <MetricCard
          label="Knowledge"
          value={overview.knowledgeStatus === "configured" ? "Configured" : "Not configured"}
          hint={
            overview.knowledgeStatus === "configured"
              ? `${mcp?.knowledgeDocumentCount ?? 0} documents reported by the company MCP`
              : "MCP health does not mean knowledge is configured"
          }
        />
        <MetricCard
          label="Structured data"
          value={overview.warehouseStatus === "configured" ? "Configured" : "Not configured"}
          hint="Company MCP warehouse / database summary"
        />
        <MetricCard
          label="AI connections"
          value={String(overview.activeAiIdentityCount ?? 0)}
          hint="Active service identities"
          to={`${base}/ai-connections`}
        />
      </MetricGrid>

      <div style={{ marginTop: 16 }}>
        <MetricGrid cols={4}>
          <MetricCard
            label="Systems"
            value={String(activeConnectors.length)}
            hint={`${connectors.length} registered`}
            to={`${base}/connectors`}
          />
          <MetricCard
            label="Usage this month"
            value={String(usage?.requestsThisMonth ?? 0)}
            hint={`${usage?.requestsToday ?? 0} today`}
            to={`${base}/usage`}
          />
          <MetricCard
            label="Wallet"
            value={wallet ? formatCurrency(wallet.balanceCents, wallet.currency) : "—"}
            hint={wallet?.lowBalance ? "Low balance" : "TEST mode"}
            to={`${base}/billing`}
          />
          <MetricCard
            label="Team"
            value={String(overview.teamCount ?? 0)}
            to={`${base}/team`}
          />
        </MetricGrid>
      </div>

      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <SectionCard title="Connected systems">
          {connectors.length === 0 && !mcp ? (
            <EmptyState
              title="Nothing connected yet"
              description="Business systems are configured per company. Nothing is assumed from another tenant."
              action={
                <Link to={`${base}/connectors`} className="button button-primary">
                  View catalogue
                </Link>
              }
            />
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {connectors.map((c) => (
                <div key={c.id} className="connection-header" style={{ marginBottom: 0 }}>
                  <strong>{c.name}</strong>
                  <StatusBadge
                    status={c.status === "draft" ? "not_configured" : c.status}
                    label={c.status === "draft" ? "Not configured" : undefined}
                  />
                </div>
              ))}
              {mcp ? (
                <div className="connection-header" style={{ marginBottom: 0 }}>
                  <div>
                    <strong>Business MCP</strong>
                    <div className="muted small">{mcp.name}</div>
                  </div>
                  <StatusBadge status={overview.mcpOnboardingStatus ?? mcp.status} />
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Recent activity">
          {overview.recentAuditEvents.length === 0 ? (
            <EmptyState title="No activity yet" description="Company changes will appear here." />
          ) : (
            <ActivityFeed
              items={overview.recentAuditEvents.slice(0, 8).map((event) => ({
                id: event.id,
                title: humanEventLabel(event.eventType),
                description: event.actor,
                meta: formatRelativeTime(event.createdAt),
              }))}
            />
          )}
        </SectionCard>
      </div>
    </>
  );
}
