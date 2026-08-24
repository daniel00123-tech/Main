import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { AuditEvent, CompanyOverview } from "@infra/shared";
import { api } from "../api";
import {
  ActionMenu,
  ActivityFeed,
  AdvancedDetails,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  MetricCard,
  MetricGrid,
  PageHeader,
  SectionCard,
  StatusBadge,
  Tabs,
  formatCurrency,
  formatDate,
} from "../components";
import {
  formatNumber,
  formatRelativeTime,
  humanEventLabel,
} from "../lib/format";

type TabId =
  | "overview"
  | "connectors"
  | "gateway"
  | "usage"
  | "billing"
  | "activity"
  | "settings";

export default function CompanyDetailPage() {
  const { slug = "" } = useParams();
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("overview");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setOverview(await api.getCompanyOverview(slug));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load company");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [slug]);

  if (loading) return <LoadingState label="Loading company…" />;
  if (error || !overview) {
    return (
      <ErrorState
        title="Unable to load company"
        description={error ?? "Company not found"}
        onRetry={() => void load()}
      />
    );
  }

  const { company, mcpEnvironments, connectorInstances, creditBalance, usageSummary, wallet, recentAuditEvents } =
    overview;
  const activeConnectors = connectorInstances.filter(
    (c) => c.status !== "disabled" && c.status !== "draft",
  ).length;
  const balanceCents = wallet?.balanceCents ?? creditBalance?.balanceCents ?? 0;
  const currency = wallet?.currency ?? creditBalance?.currency ?? "GBP";
  const unhealthy = mcpEnvironments.filter((m) =>
    ["unreachable", "degraded"].includes(m.status),
  );

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Companies", to: "/companies" },
          { label: company.name },
        ]}
        title={company.name}
        description={company.primaryDomain ?? company.slug}
        meta={<StatusBadge status={company.status} />}
        actions={
          <>
            <Link to="/portal/ai-connections" className="button button-primary">
              ChatGPT connector
            </Link>
            <Link to="/portal/dashboard" className="button button-secondary">
              Open company portal
            </Link>
            <ActionMenu
              items={[
                {
                  label: "Copy company ID",
                  onClick: () => void navigator.clipboard.writeText(company.id),
                },
                {
                  label: "View audit log",
                  onClick: () => setTab("activity"),
                },
              ]}
            />
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={(id) => setTab(id as TabId)}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "connectors", label: "Connectors", count: connectorInstances.length },
          { id: "gateway", label: "AI Gateway", count: mcpEnvironments.length },
          { id: "usage", label: "Usage" },
          { id: "billing", label: "Billing" },
          { id: "activity", label: "Activity" },
          { id: "settings", label: "Settings" },
        ]}
      />

      {tab === "overview" ? (
        <div className="stack">
          {unhealthy.length > 0 ? (
            <div className="attention-banner warn">
              <div>
                <p className="attention-title">
                  {unhealthy.length} gateway issue{unhealthy.length === 1 ? "" : "s"}
                </p>
                <p>{unhealthy.map((m) => m.name).join(", ")}</p>
              </div>
            </div>
          ) : null}

          <SectionCard
            title="Company portal"
            description="Company admins manage AI connections, usage, and billing here — including ChatGPT reconnect / new token."
          >
            <p className="muted" style={{ marginTop: 0 }}>
              Open the <strong>{company.name}</strong> portal to issue a ChatGPT Bearer token and
              point ChatGPT at the INFRA MCP URL only.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              <Link to="/portal/ai-connections" className="button button-primary">
                AI connections · ChatGPT
              </Link>
              <Link to="/portal/dashboard" className="button button-secondary">
                Portal home
              </Link>
              <Link to="/portal/billing" className="button button-secondary">
                Billing
              </Link>
              <Link to="/portal/usage" className="button button-secondary">
                Usage
              </Link>
            </div>
          </SectionCard>

          <MetricGrid cols={4}>
            <MetricCard label="Users & access" value="Manage in portal" hint="Open company portal" to="/portal/team" />
            <MetricCard
              label="Connected systems"
              value={`${activeConnectors}/${connectorInstances.length}`}
              hint="Connector instances"
            />
            <MetricCard
              label="AI gateways"
              value={formatNumber(mcpEnvironments.length)}
              hint={
                mcpEnvironments.filter((m) => m.status === "healthy").length > 0
                  ? "At least one healthy"
                  : "No healthy gateway"
              }
            />
            <MetricCard label="Available credit" value={formatCurrency(balanceCents, currency)} />
          </MetricGrid>

          <MetricGrid cols={4}>
            <MetricCard label="Requests this month" value={formatNumber(usageSummary?.requestsThisMonth ?? 0)} />
            <MetricCard label="Successful" value={formatNumber(usageSummary?.successfulThisMonth ?? 0)} />
            <MetricCard label="Failed" value={formatNumber(usageSummary?.failedThisMonth ?? 0)} />
            <MetricCard
              label="Last activity"
              value={
                recentAuditEvents[0]
                  ? formatRelativeTime(recentAuditEvents[0].createdAt)
                  : "—"
              }
            />
          </MetricGrid>

          <div className="grid grid-2">
            <SectionCard title="Connected systems">
              {connectorInstances.length === 0 ? (
                <EmptyState title="No connectors" description="Connect a business system from the catalogue." />
              ) : (
                <div className="stack" style={{ gap: 12 }}>
                  {connectorInstances.map((c) => (
                    <div key={c.id} className="connection-header" style={{ marginBottom: 0 }}>
                      <div>
                        <strong>{c.name}</strong>
                        <div className="muted small">{c.connectorDefinitionId}</div>
                      </div>
                      <StatusBadge status={c.status} />
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
            <SectionCard title="Recent activity">
              <ActivityList events={recentAuditEvents} />
            </SectionCard>
          </div>
        </div>
      ) : null}

      {tab === "connectors" ? (
        <SectionCard title="Connectors" description="Systems linked for this company.">
          {connectorInstances.length === 0 ? (
            <EmptyState
              title="No connectors yet"
              description="Browse the connector catalogue to connect a business system."
              action={
                <Link to="/connectors" className="button button-primary">
                  Browse connectors
                </Link>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Health</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {connectorInstances.map((connector) => (
                    <tr key={connector.id}>
                      <td>
                        <strong>{connector.name}</strong>
                        <div className="muted small">{connector.connectorDefinitionId}</div>
                      </td>
                      <td>
                        <StatusBadge status={connector.status} />
                      </td>
                      <td>
                        <StatusBadge status={connector.healthStatus ?? "unknown"} />
                      </td>
                      <td className="muted">{formatDate(connector.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      ) : null}

      {tab === "gateway" ? (
        <div className="grid grid-2">
          {mcpEnvironments.length === 0 ? (
            <EmptyState title="No AI gateway" description="Register an AI gateway environment for this company." />
          ) : (
            mcpEnvironments.map((mcp) => (
              <div key={mcp.id} className="entity-card">
                <div className="connection-header">
                  <h3>{mcp.name}</h3>
                  <StatusBadge status={mcp.status} />
                </div>
                <p className="muted small">Last check {formatRelativeTime(mcp.lastHealthCheckAt)}</p>
                {mcp.lastLatencyMs != null ? (
                  <p className="muted small">Latency {mcp.lastLatencyMs}ms</p>
                ) : null}
                <div style={{ marginTop: 12 }}>
                  <Link to="/mcp-environments" className="button button-secondary button-small">
                    Manage gateways
                  </Link>
                </div>
                <AdvancedDetails>
                  <KeyValue label="Environment ID" value={mcp.id} mono />
                  <KeyValue label="Endpoint" value={mcp.endpointUrl} mono />
                  <KeyValue label="Version" value={mcp.mcpVersion ?? "—"} />
                </AdvancedDetails>
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === "usage" ? (
        <SectionCard title="Usage this month" description="Requests recorded for this company.">
          <MetricGrid cols={3}>
            <MetricCard label="Requests" value={formatNumber(usageSummary?.requestsThisMonth ?? 0)} />
            <MetricCard label="Successful" value={formatNumber(usageSummary?.successfulThisMonth ?? 0)} />
            <MetricCard label="Failed" value={formatNumber(usageSummary?.failedThisMonth ?? 0)} />
          </MetricGrid>
          <p className="muted small" style={{ marginTop: 16 }}>
            Open the company portal Usage page for a detailed request log.
          </p>
        </SectionCard>
      ) : null}

      {tab === "billing" ? (
        <SectionCard title="Credit wallet">
          <MetricGrid cols={3}>
            <MetricCard label="Available credit" value={formatCurrency(balanceCents, currency)} />
            <MetricCard
              label="Low balance threshold"
              value={formatCurrency(wallet?.lowBalanceThresholdCents ?? 0, currency)}
            />
            <MetricCard
              label="Balance status"
              value={wallet?.lowBalance ? "Low" : "OK"}
            />
          </MetricGrid>
          <div style={{ marginTop: 16 }}>
            <Link to="/portal/billing" className="button button-primary">
              Manage in portal
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {tab === "activity" ? (
        <SectionCard title="Activity">
          <ActivityList events={recentAuditEvents} />
        </SectionCard>
      ) : null}

      {tab === "settings" ? (
        <SectionCard title="Company settings">
          <KeyValue label="Name" value={company.name} />
          <KeyValue label="Slug" value={company.slug} mono />
          <KeyValue label="Domain" value={company.primaryDomain ?? "—"} />
          <KeyValue label="Status" value={<StatusBadge status={company.status} />} />
          <AdvancedDetails>
            <KeyValue label="Company ID" value={company.id} mono />
            {company.notes ? <KeyValue label="Notes" value={company.notes} /> : null}
          </AdvancedDetails>
        </SectionCard>
      ) : null}
    </>
  );
}

function ActivityList({ events }: { events: AuditEvent[] }) {
  const items = useMemo(
    () =>
      events.slice(0, 12).map((event) => ({
        id: event.id,
        title: humanEventLabel(event.eventType),
        description: event.actor,
        meta: formatRelativeTime(event.createdAt),
      })),
    [events],
  );
  return <ActivityFeed items={items} />;
}
