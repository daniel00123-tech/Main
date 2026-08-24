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
import { formatRelativeTime, greetingForNow, humanEventLabel } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalDashboardPage() {
  const { company, overview, loading, error, user, membership } = usePortalCompany();

  if (loading) return <LoadingState label="Loading your company…" />;
  if (error || !company || !overview || !user) {
    return <ErrorState title="Unable to load dashboard" description={error ?? undefined} />;
  }

  const base = `/portal/${company.slug}`;
  const mcp = overview.mcpEnvironments[0];
  const usage = overview.usageSummary;
  const wallet = overview.wallet;
  const connectors = overview.connectorInstances;
  const activeConnectors = connectors.filter(
    (item) => item.status !== "disabled" && item.status !== "draft",
  );
  const attention: Array<{ id: string; title: string; description?: string; to?: string }> = [];
  if (mcp && ["unreachable", "degraded"].includes(mcp.status)) {
    attention.push({
      id: "mcp",
      title: "AI connection needs attention",
      description: mcp.healthMessage ?? mcp.status,
      to: `${base}/ai-connections`,
    });
  }
  if (wallet?.lowBalance) {
    attention.push({
      id: "wallet",
      title: "Credit balance is low",
      description: "Add credit to keep requests flowing",
      to: `${base}/billing`,
    });
  }

  const isFresh =
    activeConnectors.length === 0 &&
    overview.mcpEnvironments.length === 0 &&
    (usage?.requestsThisMonth ?? 0) === 0;

  return (
    <>
      <PageHeader
        title={greetingForNow(user.displayName)}
        description={`${company.name} · ${membership?.role ? membership.role.replace(/_/g, " ") : "member"}`}
        meta={<StatusBadge status={company.status} />}
      />

      <AttentionBanner
        items={attention}
        allClear="Everything is running normally"
      />

      <SectionCard
        title="ChatGPT connector"
        description="Generate a Bearer token and point ChatGPT at the INFRA MCP URL — no backend setup required."
      >
        <p className="muted" style={{ marginTop: 0 }}>
          Path: <strong>{company.name}</strong> → AI connections → ChatGPT → Generate / Reconnect
          token → INFRA MCP URL
        </p>
        <Link to={`${base}/ai-connections`} className="button button-primary">
          Open AI connections · ChatGPT
        </Link>
      </SectionCard>

      {isFresh ? (
        <SectionCard title="Welcome to INFRA" description="Let's connect your company.">
          <ol className="stack" style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
            <li>
              <Link to={`${base}/connectors`}>Connect a business system</Link>
            </li>
            <li>
              <Link to={`${base}/ai-connections`}>Connect AI</Link>
            </li>
            <li>
              <Link to={`${base}/team`}>Invite your team</Link>
            </li>
            <li>Configure permissions</li>
            <li>Start using INFRA</li>
          </ol>
        </SectionCard>
      ) : null}

      <MetricGrid cols={4}>
        <MetricCard
          label="Connected systems"
          value={String(activeConnectors.length)}
          hint={`${connectors.length} total`}
          to={`${base}/connectors`}
        />
        <MetricCard
          label="AI gateway"
          value={mcp ? <StatusBadge status={mcp.status} /> : "—"}
          hint={mcp?.name ?? "Not configured"}
          to={`${base}/ai-connections`}
        />
        <MetricCard
          label="Usage this month"
          value={String(usage?.requestsThisMonth ?? 0)}
          hint={`${usage?.requestsToday ?? 0} today`}
          to={`${base}/usage`}
        />
        <MetricCard
          label="Available credit"
          value={wallet ? formatCurrency(wallet.balanceCents, wallet.currency) : "—"}
          hint={wallet?.lowBalance ? "Low balance" : "Wallet"}
          to={`${base}/billing`}
        />
      </MetricGrid>

      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <SectionCard title="Connected systems">
          {connectors.length === 0 && !mcp ? (
            <EmptyState
              title="Nothing connected yet"
              description="Connect a business system or AI assistant to get started."
              action={
                <Link to={`${base}/connectors`} className="button button-primary">
                  Connect system
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
                    label={c.status === "draft" ? "Not connected" : undefined}
                  />
                </div>
              ))}
              {mcp ? (
                <div className="connection-header" style={{ marginBottom: 0 }}>
                  <div>
                    <strong>AI gateway</strong>
                    <div className="muted small">{mcp.name}</div>
                  </div>
                  <StatusBadge status={mcp.status} />
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Recent activity">
          <ActivityFeed
            items={overview.recentAuditEvents.slice(0, 8).map((event) => ({
              id: event.id,
              title: humanEventLabel(event.eventType),
              description: event.actor,
              meta: formatRelativeTime(event.createdAt),
            }))}
          />
        </SectionCard>
      </div>
    </>
  );
}
