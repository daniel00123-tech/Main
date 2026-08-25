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

function unavailable(value: string | null | undefined): string {
  return value ? formatRelativeTime(value) : "Unavailable";
}

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
  const knowledgeSource = overview.knowledgeSources?.[0];
  const documentCount = knowledgeSource?.documentCount ?? mcp?.knowledgeDocumentCount ?? null;
  const chunkCount = knowledgeSource?.chunkCount ?? mcp?.knowledgeChunkCount ?? null;
  const lastSync = knowledgeSource?.lastSyncAt ?? mcp?.lastSyncAt ?? null;
  const testCents = overview.walletCredits?.testCents ?? 0;
  const paidCents = overview.walletCredits?.paidCents ?? 0;
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
      description: "Paid AI operations and connector writes are blocked.",
      to: `${base}/settings`,
    });
  }

  const knowledgeValue =
    documentCount != null
      ? `${documentCount} documents`
      : overview.knowledgeStatus === "configured"
        ? "Configured"
        : "Not configured";

  return (
    <>
      <PageHeader
        title={greetingForNow(user.displayName)}
        description={`${company.name} · ${membership?.role ? membership.role.replace(/_/g, " ") : "member"}`}
        meta={<StatusBadge status={company.status} />}
      />

      <AttentionBanner items={attention} allClear="No alerts right now" />

      <MetricGrid cols={4}>
        <MetricCard
          label="Business MCP"
          value={
            <StatusBadge
              status={overview.mcpOnboardingStatus ?? "not_provisioned"}
              label={mcp ? undefined : "Not provisioned"}
            />
          }
          hint={mcp ? `${mcp.name} · ${mcp.healthMessage ?? mcp.status}` : "Register an existing MCP"}
        />
        <MetricCard
          label="Knowledge"
          value={knowledgeValue}
          hint={
            documentCount != null
              ? `${chunkCount ?? "—"} chunks · Last sync: ${lastSync ? unavailable(lastSync) : "Unavailable"}`
              : "Reported by the company Business MCP — not stored in INFRA"
          }
        />
        <MetricCard
          label="AI connections"
          value={String(overview.activeAiIdentityCount ?? 0)}
          hint="Active ChatGPT / Claude tokens"
          to={`${base}/ai-connections`}
        />
        <MetricCard
          label="Wallet"
          value={wallet ? formatCurrency(wallet.balanceCents, wallet.currency) : "—"}
          hint={`TEST ${formatCurrency(testCents, wallet?.currency ?? "GBP")} · Paid ${formatCurrency(paidCents, wallet?.currency ?? "GBP")}`}
          to={`${base}/billing`}
        />
      </MetricGrid>

      <div style={{ marginTop: 16 }}>
        <MetricGrid cols={4}>
          <MetricCard
            label="Usage today"
            value={String(usage?.requestsToday ?? 0)}
            hint={`${usage?.requestsThisMonth ?? 0} this month`}
            to={`${base}/usage`}
          />
          <MetricCard
            label="Usage this month"
            value={String(usage?.requestsThisMonth ?? 0)}
            hint={`${usage?.successfulThisMonth ?? 0} successful`}
            to={`${base}/usage`}
          />
          <MetricCard
            label="Team"
            value={String(overview.teamCount ?? 0)}
            to={`${base}/team`}
          />
          <MetricCard
            label="Systems"
            value={String(connectors.filter((item) => item.status !== "draft").length)}
            hint={`${connectors.length} registered`}
            to={`${base}/connectors`}
          />
        </MetricGrid>
      </div>

      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <SectionCard
          title="Connected systems"
          description="Business systems reported to INFRA. Files and operational data stay on the company MCP."
        >
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
              {connectors.map((item) => (
                <div key={item.id} className="connection-header" style={{ marginBottom: 0 }}>
                  <div>
                    <strong>{item.name}</strong>
                    <div className="muted small">
                      {item.managedBy === "company_mcp"
                        ? "Managed by company Business MCP"
                        : item.authStatus === "connected"
                          ? "Connected"
                          : "Requires setup"}
                    </div>
                  </div>
                  <StatusBadge
                    status={item.status === "draft" ? "not_configured" : item.status}
                    label={item.status === "draft" ? "Not configured" : undefined}
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

      <div style={{ marginTop: 24 }}>
      <SectionCard
        title="Setup"
        description="Required items must be complete. Optional items do not fail readiness."
      >
        {overview.onboarding ? (
          <OnboardingChecklist onboarding={overview.onboarding} />
        ) : (
          <p className="muted">Readiness is not available yet.</p>
        )}
      </SectionCard>
      </div>
    </>
  );
}
