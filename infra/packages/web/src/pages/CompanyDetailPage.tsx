import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { AuditEvent, CompanyOverview } from "@infra/shared";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
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
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  Tabs,
  formatCurrency,
  formatDate,
  toast,
} from "../components";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import {
  formatNumber,
  formatRelativeTime,
  humanEventLabel,
} from "../lib/format";

type TabId =
  | "overview"
  | "mcp"
  | "connectors"
  | "usage"
  | "billing"
  | "activity"
  | "settings";

export default function CompanyDetailPage() {
  const { slug = "" } = useParams();
  const { user } = useAuth();
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  const [busy, setBusy] = useState(false);
  const [mcpForm, setMcpForm] = useState({
    name: "",
    endpointUrl: "",
    authSecretRef: "",
    serviceBindingRef: "",
    description: "",
  });

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

  async function changeStatus(status: "active" | "suspended" | "archived") {
    if (!overview) return;
    setBusy(true);
    try {
      await api.setCompanyStatus(overview.company.slug, status);
      toast(`Company ${status}`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to update status", "error");
    } finally {
      setBusy(false);
    }
  }

  async function registerMcp(event: FormEvent) {
    event.preventDefault();
    if (!overview) return;
    setBusy(true);
    try {
      await api.registerExistingMcp({
        companySlug: overview.company.slug,
        name: mcpForm.name,
        endpointUrl: mcpForm.endpointUrl,
        authSecretRef: mcpForm.authSecretRef,
        serviceBindingRef: mcpForm.serviceBindingRef || undefined,
        description: mcpForm.description || undefined,
      });
      toast("Existing Business MCP registered");
      setMcpForm({
        name: "",
        endpointUrl: "",
        authSecretRef: "",
        serviceBindingRef: "",
        description: "",
      });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to register MCP", "error");
    } finally {
      setBusy(false);
    }
  }

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

  const {
    company,
    mcpEnvironments,
    connectorInstances,
    creditBalance,
    usageSummary,
    wallet,
    recentAuditEvents,
    onboarding,
  } = overview;
  const mcp = mcpEnvironments[0] ?? null;
  const activeConnectors = connectorInstances.filter(
    (c) => c.status !== "disabled" && c.status !== "draft",
  ).length;
  const balanceCents = wallet?.balanceCents ?? creditBalance?.balanceCents ?? 0;
  const currency = wallet?.currency ?? creditBalance?.currency ?? company.currency ?? "GBP";
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
        description={`${company.tradingName ?? company.slug} · ${company.timezone ?? "timezone not set"}`}
        meta={<StatusBadge status={company.status} />}
        actions={
          <>
            <Link to={`/portal/${company.slug}/dashboard`} className="button button-primary">
              Open company portal
            </Link>
            <ActionMenu
              items={[
                {
                  label: "Copy company ID",
                  onClick: () => void navigator.clipboard.writeText(company.id),
                },
                {
                  label: "View activity",
                  onClick: () => setTab("activity"),
                },
                ...(user?.isPlatformAdmin && company.status !== "suspended"
                  ? [
                      {
                        label: "Suspend company",
                        danger: true,
                        disabled: busy,
                        onClick: () => void changeStatus("suspended"),
                      },
                    ]
                  : []),
                ...(user?.isPlatformAdmin && company.status === "suspended"
                  ? [
                      {
                        label: "Reactivate",
                        disabled: busy,
                        onClick: () => void changeStatus("active"),
                      },
                    ]
                  : []),
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
          { id: "mcp", label: "Business MCP", count: mcpEnvironments.length },
          { id: "connectors", label: "Connectors", count: connectorInstances.length },
          { id: "usage", label: "Usage" },
          { id: "billing", label: "Billing" },
          { id: "activity", label: "Activity" },
          { id: "settings", label: "Configuration" },
        ]}
      />

      {tab === "overview" ? (
        <div className="stack">
          {company.status === "suspended" ? (
            <Notice tone="warning">
              This company is suspended. Paid AI operations are blocked. Data is retained.
            </Notice>
          ) : null}
          {unhealthy.length > 0 ? (
            <div className="attention-banner warn">
              <div>
                <p className="attention-title">
                  {unhealthy.length} Business MCP issue{unhealthy.length === 1 ? "" : "s"}
                </p>
                <p>{unhealthy.map((m) => m.name).join(", ")}</p>
              </div>
            </div>
          ) : null}

          <SectionCard
            title="Onboarding"
            description="Truthful INFRA-side state. Green only means the named foundation exists."
          >
            {onboarding ? (
              <OnboardingChecklist onboarding={onboarding} />
            ) : (
              <EmptyState title="Onboarding unavailable" description="Reload to compute the checklist." />
            )}
          </SectionCard>

          <MetricGrid cols={4}>
            <MetricCard
              label="Business MCP"
              value={overview.mcpOnboardingStatus ?? "not_provisioned"}
              hint={mcp ? mcp.name : "Not provisioned"}
            />
            <MetricCard
              label="Knowledge"
              value={
                mcp?.knowledgeDocumentCount != null
                  ? `${formatNumber(mcp.knowledgeDocumentCount)} docs`
                  : overview.knowledgeStatus === "configured"
                    ? "Configured"
                    : "Not configured"
              }
              hint={
                mcp?.knowledgeChunkCount != null
                  ? `${formatNumber(mcp.knowledgeChunkCount)} chunks · Last sync ${mcp.lastSyncAt ?? "Unavailable"}`
                  : "Reported by company MCP — not inferred from health"
              }
            />
            <MetricCard
              label="AI connections"
              value={formatNumber(overview.activeAiIdentityCount ?? 0)}
              hint={`${overview.aiIdentityCount ?? 0} identities`}
              to={`/portal/${company.slug}/ai-connections`}
            />
            <MetricCard label="Available credit" value={formatCurrency(balanceCents, currency)} />
          </MetricGrid>

          <MetricGrid cols={4}>
            <MetricCard
              label="Team"
              value={formatNumber(overview.teamCount ?? 0)}
              to={`/portal/${company.slug}/team`}
            />
            <MetricCard
              label="Systems"
              value={`${activeConnectors}/${connectorInstances.length}`}
            />
            <MetricCard label="Requests this month" value={formatNumber(usageSummary?.requestsThisMonth ?? 0)} />
            <MetricCard
              label="Last activity"
              value={
                overview.lastActivityAt ? formatRelativeTime(overview.lastActivityAt) : "—"
              }
            />
          </MetricGrid>
        </div>
      ) : null}

      {tab === "mcp" ? (
        <div className="stack">
          {mcpEnvironments.length === 0 ? (
            <EmptyState
              title="Business MCP not provisioned"
              description="Creating a company does not create a Worker, D1, or company MCP. Register an existing MCP when one exists."
            />
          ) : (
            mcpEnvironments.map((item) => (
              <div key={item.id} className="entity-card">
                <div className="connection-header">
                  <h3>{item.name}</h3>
                  <StatusBadge status={item.status} />
                </div>
                <p className="muted small">
                  {item.healthMessage ?? "Awaiting authenticated health check"}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          await api.refreshMcpCapabilities(item.id);
                          toast("Capabilities refreshed · not billed");
                          await load();
                        } catch (err) {
                          toast(
                            err instanceof Error ? err.message : "Refresh failed",
                            "error",
                          );
                        } finally {
                          setBusy(false);
                        }
                      })()
                    }
                  >
                    Refresh capabilities
                  </button>
                </div>
                <AdvancedDetails>
                  <KeyValue label="Environment ID" value={item.id} mono />
                  <KeyValue label="Endpoint" value={item.endpointUrl} mono />
                  <KeyValue label="Secret reference" value={item.authSecretRef ?? "—"} mono />
                  <KeyValue label="Service binding" value={item.serviceBindingRef ?? "—"} mono />
                  <KeyValue label="Version" value={item.mcpVersion ?? "—"} />
                  <KeyValue label="Core version" value={item.businessMcpCoreVersion ?? "—"} />
                  <KeyValue
                    label="Knowledge documents"
                    value={
                      item.knowledgeDocumentCount == null
                        ? "not reported"
                        : String(item.knowledgeDocumentCount)
                    }
                  />
                  <KeyValue
                    label="Knowledge chunks"
                    value={
                      item.knowledgeChunkCount == null
                        ? "not reported"
                        : String(item.knowledgeChunkCount)
                    }
                  />
                  <KeyValue
                    label="Last knowledge sync"
                    value={item.lastSyncAt ?? "Unavailable"}
                  />
                  <KeyValue
                    label="Tools"
                    value={item.capabilities.length ? item.capabilities.join(", ") : "—"}
                  />
                </AdvancedDetails>
              </div>
            ))
          )}

          {user?.isPlatformAdmin ? (
            <SectionCard
              title="Register an existing Business MCP"
              description="Does not create Cloudflare resources. Store only a secret reference name, never the token."
            >
              <form className="form-grid" onSubmit={(event) => void registerMcp(event)}>
                <label>
                  MCP name
                  <input
                    value={mcpForm.name}
                    onChange={(e) => setMcpForm((prev) => ({ ...prev, name: e.target.value }))}
                    required
                  />
                </label>
                <label>
                  Endpoint URL
                  <input
                    value={mcpForm.endpointUrl}
                    onChange={(e) =>
                      setMcpForm((prev) => ({ ...prev, endpointUrl: e.target.value }))
                    }
                    placeholder="https://company-mcp.example.workers.dev/mcp"
                    required
                  />
                </label>
                <label>
                  Auth secret reference
                  <input
                    value={mcpForm.authSecretRef}
                    onChange={(e) =>
                      setMcpForm((prev) => ({ ...prev, authSecretRef: e.target.value }))
                    }
                    placeholder="COMPANY_MCP_AUTH_TOKEN"
                    required
                  />
                </label>
                <label>
                  Service binding (optional)
                  <input
                    value={mcpForm.serviceBindingRef}
                    onChange={(e) =>
                      setMcpForm((prev) => ({ ...prev, serviceBindingRef: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Notes
                  <input
                    value={mcpForm.description}
                    onChange={(e) =>
                      setMcpForm((prev) => ({ ...prev, description: e.target.value }))
                    }
                  />
                </label>
                <button type="submit" className="button button-primary" disabled={busy}>
                  Register existing MCP
                </button>
              </form>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {tab === "connectors" ? (
        <SectionCard title="Connectors" description="Company instances. Catalogue items are shared.">
          {connectorInstances.length === 0 ? (
            <EmptyState
              title="No connectors yet"
              description="Open the company portal catalogue. Credential submission stays disabled until secure storage exists."
              action={
                <Link to={`/portal/${company.slug}/connectors`} className="button button-primary">
                  Open portal connectors
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
                    <th>Auth</th>
                    <th>Sync</th>
                    <th>Last sync</th>
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
                        <StatusBadge status={connector.authStatus ?? connector.healthStatus ?? "unknown"} />
                      </td>
                      <td>
                        <StatusBadge status={connector.syncHealth ?? connector.lastSyncStatus ?? "unknown"} />
                      </td>
                      <td className="muted">
                        {connector.lastSyncAt ? formatDate(connector.lastSyncAt) : "Unavailable"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      ) : null}

      {tab === "usage" ? (
        <SectionCard title="Usage this month" description="Requests recorded for this company.">
          {(usageSummary?.requestsThisMonth ?? 0) === 0 ? (
            <EmptyState title="No usage yet" description="Usage appears after an AI client calls INFRA." />
          ) : (
            <MetricGrid cols={3}>
              <MetricCard label="Requests" value={formatNumber(usageSummary?.requestsThisMonth ?? 0)} />
              <MetricCard label="Successful" value={formatNumber(usageSummary?.successfulThisMonth ?? 0)} />
              <MetricCard label="Failed" value={formatNumber(usageSummary?.failedThisMonth ?? 0)} />
            </MetricGrid>
          )}
          <div style={{ marginTop: 16 }}>
            <Link to={`/portal/${company.slug}/usage`} className="button button-secondary">
              Open portal usage
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {tab === "billing" ? (
        <SectionCard title="Wallet">
          <MetricGrid cols={3}>
            <MetricCard label="Available credit" value={formatCurrency(balanceCents, currency)} />
            <MetricCard
              label="Low balance threshold"
              value={formatCurrency(wallet?.lowBalanceThresholdCents ?? 0, currency)}
            />
            <MetricCard label="Billing mode" value={company.billingMode === "live" ? "Live" : "TEST"} />
          </MetricGrid>
          <div style={{ marginTop: 16 }}>
            <Link to={`/portal/${company.slug}/billing`} className="button button-primary">
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
        <SectionCard title="Company configuration">
          <KeyValue label="Name" value={company.name} />
          <KeyValue label="Slug" value={company.slug} mono />
          <KeyValue label="Status" value={<StatusBadge status={company.status} />} />
          <KeyValue label="Timezone" value={company.timezone ?? "—"} />
          <KeyValue label="Currency" value={company.currency ?? "GBP"} />
          <KeyValue label="Billing mode" value={company.billingMode ?? "test"} />
          <AdvancedDetails>
            <KeyValue label="Company ID" value={company.id} mono />
            {company.notes ? <KeyValue label="Notes" value={company.notes} /> : null}
          </AdvancedDetails>
          {user?.isPlatformAdmin ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
              {company.status === "suspended" ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void changeStatus("active")}
                >
                  Reactivate
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void changeStatus("suspended")}
                >
                  Suspend
                </button>
              )}
              {company.status !== "archived" && company.status !== "closed" ? (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() => void changeStatus("archived")}
                >
                  Archive
                </button>
              ) : null}
            </div>
          ) : null}
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
  return events.length === 0 ? (
    <EmptyState title="No activity yet" description="Administrative changes will appear here." />
  ) : (
    <ActivityFeed items={items} />
  );
}
