import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AuditEvent, CompanyOverview, InfraUser } from "@infra/shared";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import {
  ActionMenu,
  ActivityFeed,
  AdvancedDetails,
  Button,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  MetricCard,
  MetricGrid,
  Modal,
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
import { PermissionsEditor } from "../components/PermissionsEditor";
import { Microsoft365AdminPanel } from "../components/connectors/Microsoft365AdminPanel";
import type { ActionPlanRecord } from "@infra/shared";
import {
  formatNumber,
  formatRelativeTime,
  humanEventLabel,
} from "../lib/format";

type TabId =
  | "overview"
  | "users"
  | "permissions"
  | "approvals"
  | "commercial"
  | "mcp"
  | "connectors"
  | "usage"
  | "billing"
  | "activity"
  | "settings";

export default function CompanyDetailPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
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
  const [lifecycleModal, setLifecycleModal] = useState<{
    action: "suspend" | "archive" | "delete" | "reactivate";
    reason: string;
  } | null>(null);
  const [companyUsers, setCompanyUsers] = useState<InfraUser[]>([]);
  const [invitations, setInvitations] = useState<Array<Record<string, unknown>>>([]);
  const [walletHealth, setWalletHealth] = useState<Awaited<
    ReturnType<typeof api.getWalletHealth>
  >["health"] | null>(null);
  const [autoTopUpDiag, setAutoTopUpDiag] = useState<Record<string, unknown> | null>(null);
  const [tabDataLoading, setTabDataLoading] = useState(false);
  const [rolePresets, setRolePresets] = useState<Awaited<ReturnType<typeof api.getRolePresets>>>([]);
  const [actionPlans, setActionPlans] = useState<ActionPlanRecord[]>([]);
  const [testArtefacts, setTestArtefacts] = useState<
    Awaited<ReturnType<typeof api.listXeroTestArtefacts>> | null
  >(null);
  const [warehouse, setWarehouse] = useState<Awaited<ReturnType<typeof api.getWarehouse>>["warehouse"] | null>(null);

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

  useEffect(() => {
    if (!overview) return;
    if (tab !== "users" && tab !== "commercial" && tab !== "overview" && tab !== "permissions" && tab !== "approvals" && tab !== "settings" && tab !== "connectors") return;
    setTabDataLoading(true);
    void (async () => {
      try {
        if (tab === "users" || tab === "overview") {
          const [users, inv] = await Promise.all([
            api.getUsers(overview.company.id),
            api.getInvitations(overview.company.slug).catch(() => ({ invitations: [] })),
          ]);
          setCompanyUsers(users);
          setInvitations(inv.invitations);
        }
        if (tab === "commercial" || tab === "overview") {
          const [health, diag] = await Promise.all([
            api.getWalletHealth(overview.company.slug),
            api.getAutoTopUpDiagnostics(overview.company.slug),
          ]);
          setWalletHealth(health.health);
          setAutoTopUpDiag(diag.diagnostics);
        }
        if (tab === "permissions") {
          setRolePresets(await api.getRolePresets());
        }
        if (tab === "approvals") {
          const actions = await api.listCompanyActions(overview.company.slug);
          setActionPlans(actions.plans);
        }
        if (tab === "settings" && user?.isPlatformAdmin) {
          setTestArtefacts(
            await api.listXeroTestArtefacts(overview.company.slug, "INFRA-").catch(() => null),
          );
        }
        if ((tab === "connectors" || tab === "overview") && user?.isPlatformAdmin) {
          const wh = await api.getWarehouse(overview.company.id).catch(() => null);
          setWarehouse(wh?.warehouse ?? null);
        }
      } catch {
        /* non-blocking tab data */
      } finally {
        setTabDataLoading(false);
      }
    })();
  }, [tab, overview?.company.id, overview?.company.slug]);

  async function applyLifecycle() {
    if (!overview || !lifecycleModal) return;
    setBusy(true);
    try {
      if (lifecycleModal.action === "delete") {
        await api.deleteCompany(overview.company.slug);
        toast("Company deleted");
        navigate("/companies");
        return;
      }
      const status =
        lifecycleModal.action === "suspend"
          ? "suspended"
          : lifecycleModal.action === "archive"
            ? "archived"
            : "active";
      await api.setCompanyStatus(
        overview.company.slug,
        status,
        lifecycleModal.reason.trim() || undefined,
      );
      toast(`Company ${status}`);
      setLifecycleModal(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to update company", "error");
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: "active" | "suspended" | "archived") {
    if (!overview) return;
    if (status === "suspended") {
      setLifecycleModal({ action: "suspend", reason: "" });
      return;
    }
    if (status === "archived") {
      setLifecycleModal({ action: "archive", reason: "" });
      return;
    }
    setLifecycleModal({ action: "reactivate", reason: "" });
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
            <Link to={`/portal/${company.slug}/chat`} className="button button-primary">
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
                ...(user?.isPlatformAdmin && company.status !== "archived"
                  ? [
                      {
                        label: "Archive company",
                        disabled: busy,
                        onClick: () => void changeStatus("archived"),
                      },
                    ]
                  : []),
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
                ...(user?.isPlatformAdmin
                  ? [
                      {
                        label: "Delete company (if safe)",
                        danger: true,
                        disabled: busy,
                        onClick: () => setLifecycleModal({ action: "delete", reason: "" }),
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
          { id: "users", label: "Users", count: overview.teamCount ?? undefined },
          { id: "permissions", label: "Permissions" },
          { id: "approvals", label: "Approvals", count: actionPlans.filter((p) => p.status === "awaiting_approval").length || undefined },
          { id: "commercial", label: "Commercial" },
          { id: "mcp", label: "AI Access", count: mcpEnvironments.length },
          { id: "connectors", label: "Systems", count: connectorInstances.length },
          { id: "usage", label: "Usage" },
          { id: "billing", label: "Billing" },
          { id: "activity", label: "Activity" },
          { id: "settings", label: "Settings" },
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

          {walletHealth ? (
            <MetricGrid cols={4}>
              <MetricCard
                label="Wallet health"
                value={walletHealth.state}
                hint={`Paid ${formatCurrency(walletHealth.paidCents, currency)} · Promo ${formatCurrency(walletHealth.promotionalCents, currency)}`}
              />
              <MetricCard
                label="Auto top-up"
                value={autoTopUpDiag?.enabled ? "On" : "Off"}
                hint={
                  autoTopUpDiag?.executionEnabled
                    ? "Execution enabled"
                    : "Execution disabled (safe)"
                }
              />
              <MetricCard
                label="Pending invitations"
                value={formatNumber(invitations.filter((i) => i.status === "pending").length)}
              />
              <MetricCard
                label="Billing status"
                value={company.billingMode === "live" ? "Live" : "Test mode"}
              />
            </MetricGrid>
          ) : tabDataLoading ? (
            <LoadingState label="Loading commercial summary…" />
          ) : null}

          <MetricGrid cols={4}>
            <MetricCard
              label="Team"
              value={formatNumber(overview.teamCount ?? 0)}
              to={`/portal/${company.slug}/users`}
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

      {tab === "users" ? (
        <div className="stack">
          <SectionCard title="Team members" description="Company users and roles.">
            {tabDataLoading ? (
              <LoadingState label="Loading users…" />
            ) : companyUsers.length === 0 ? (
              <EmptyState title="No users" description="Invite users from the company portal." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companyUsers.map((u) => {
                      const membership = u.memberships.find(
                        (m) => m.companyId === overview.company.id,
                      );
                      return (
                      <tr key={String(u.id)}>
                        <td>{String(u.displayName ?? "—")}</td>
                        <td>{String(u.email ?? "—")}</td>
                        <td>{String(membership?.role ?? "—")}</td>
                        <td>
                          <StatusBadge status={String(u.status ?? "unknown")} />
                        </td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <Link to={`/portal/${company.slug}/users`} className="button button-primary">
                Manage in portal
              </Link>
            </div>
          </SectionCard>

          <SectionCard title="Invitations" description="Pending and recent invitations.">
            {invitations.length === 0 ? (
              <EmptyState title="No invitations" description="Active invites appear here." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((inv) => (
                      <tr key={String(inv.id)}>
                        <td>{String(inv.email)}</td>
                        <td>{String(inv.role)}</td>
                        <td>
                          <StatusBadge status={String(inv.status)} />
                        </td>
                        <td className="muted small">
                          {inv.expiresAt ? formatDate(String(inv.expiresAt)) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {tab === "permissions" ? (
        <div className="stack">
          {tabDataLoading ? (
            <LoadingState label="Loading permissions…" />
          ) : (
            <PermissionsEditor companySlug={company.slug} roles={rolePresets} />
          )}
        </div>
      ) : null}

      {tab === "approvals" ? (
        <div className="stack">
          <SectionCard title="Action approvals" description="Pending and recent governed accounting actions.">
            {tabDataLoading ? (
              <LoadingState label="Loading approvals…" />
            ) : actionPlans.length === 0 ? (
              <EmptyState title="No action plans" description="Governed actions appear here when planned." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Requester</th>
                      <th>Status</th>
                      <th>Risk</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionPlans.slice(0, 50).map((plan) => (
                      <tr key={plan.id}>
                        <td>{plan.summary ?? plan.requestedAction}</td>
                        <td>{plan.actor}</td>
                        <td><StatusBadge status={plan.status} /></td>
                        <td>{plan.riskClass}</td>
                        <td className="muted small">{formatRelativeTime(plan.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <Link to={`/portal/${company.slug}/actions`} className="button button-primary">
                Open approvals centre
              </Link>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {tab === "commercial" ? (
        <div className="stack">
          {tabDataLoading ? (
            <LoadingState label="Loading commercial data…" />
          ) : (
            <>
              <SectionCard title="Wallet & credit">
                {walletHealth ? (
                  <MetricGrid cols={4}>
                    <MetricCard
                      label="Balance"
                      value={formatCurrency(walletHealth.balanceCents, currency)}
                    />
                    <MetricCard label="Health" value={walletHealth.state} />
                    <MetricCard
                      label="Paid credit"
                      value={formatCurrency(walletHealth.paidCents, currency)}
                    />
                    <MetricCard
                      label="Promotional credit"
                      value={formatCurrency(walletHealth.promotionalCents, currency)}
                    />
                  </MetricGrid>
                ) : (
                  <EmptyState title="Wallet unavailable" />
                )}
              </SectionCard>

              <SectionCard title="Auto top-up diagnostics" description="No secrets shown. Execution gate status for operators.">
                {autoTopUpDiag ? (
                  <div className="kv-stack">
                    <KeyValue label="Auto top-up" value={autoTopUpDiag.enabled ? "On" : "Off"} />
                    <KeyValue
                      label="Execution"
                      value={autoTopUpDiag.executionEnabled ? "Enabled" : "Disabled"}
                    />
                    <KeyValue
                      label="Threshold"
                      value={formatCurrency(Number(autoTopUpDiag.thresholdCents ?? 0), currency)}
                    />
                    <KeyValue
                      label="Top-up amount"
                      value={formatCurrency(Number(autoTopUpDiag.amountCents ?? 0), currency)}
                    />
                    <KeyValue
                      label="Saved card"
                      value={
                        autoTopUpDiag.paymentMethod &&
                        typeof autoTopUpDiag.paymentMethod === "object" &&
                        (autoTopUpDiag.paymentMethod as { ready?: boolean }).ready
                          ? `${String((autoTopUpDiag.paymentMethod as { brand?: string }).brand ?? "Card")} ···${String((autoTopUpDiag.paymentMethod as { last4?: string }).last4 ?? "????")}`
                          : "Not saved"
                      }
                    />
                    <KeyValue label="Portal status" value={String(autoTopUpDiag.portalStatus ?? "—")} />
                    <KeyValue
                      label="Daily auto top-up"
                      value={`${formatCurrency(Number(autoTopUpDiag.dailySpentCents ?? 0), currency)} / ${formatCurrency(Number(autoTopUpDiag.dailyCapCents ?? 0), currency)}`}
                    />
                    <KeyValue
                      label="Monthly auto top-up"
                      value={`${formatCurrency(Number(autoTopUpDiag.monthlySpentCents ?? 0), currency)} / ${formatCurrency(Number(autoTopUpDiag.monthlyCapCents ?? 0), currency)}`}
                    />
                    {autoTopUpDiag.suppressedUntil ? (
                      <KeyValue
                        label="Suppressed until"
                        value={formatDate(String(autoTopUpDiag.suppressedUntil))}
                      />
                    ) : null}
                    {autoTopUpDiag.lastFailure &&
                    typeof autoTopUpDiag.lastFailure === "object" ? (
                      <KeyValue
                        label="Last failure"
                        value={String(
                          (autoTopUpDiag.lastFailure as { failureReason?: string }).failureReason ??
                            "Unknown",
                        )}
                      />
                    ) : null}
                  </div>
                ) : (
                  <EmptyState title="Diagnostics unavailable" />
                )}
              </SectionCard>
            </>
          )}
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
        <div className="stack">
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

          {user?.isPlatformAdmin && warehouse ? (
            <SectionCard
              title="Xero Warehouse"
              description="Structured historical Xero analytics. Xero remains the system of record."
            >
              <MetricGrid cols={3}>
                <MetricCard label="Status" value={warehouse.status} />
                <MetricCard
                  label="Last successful sync"
                  value={warehouse.lastSuccessfulSync ? formatDate(warehouse.lastSuccessfulSync) : "Never"}
                />
                <MetricCard label="Next scheduled sync" value={formatDate(warehouse.nextScheduledSync)} />
              </MetricGrid>
              <div className="muted small" style={{ marginTop: 12 }}>
                Historical range: {warehouse.historicalRange.from ?? "n/a"} → {warehouse.historicalRange.to ?? "n/a"}
                {warehouse.records
                  ? ` · invoices ${warehouse.records.invoices} · lines ${warehouse.records.invoiceLines} · contacts ${warehouse.records.contacts} · payments ${warehouse.records.payments}`
                  : ""}
              </div>
              <div className="muted small">
                Reconciliation:{" "}
                {warehouse.latestReconciliation
                  ? warehouse.latestReconciliation.passed
                    ? `passed (MTD ${warehouse.latestReconciliation.mtdSalesWarehouse} vs live ${warehouse.latestReconciliation.mtdSalesLive})`
                    : `diverged (${warehouse.latestReconciliation.divergence.join(", ") || "unknown"})`
                  : "none yet"}
              </div>
              {warehouse.failures.length ? (
                <div className="muted small">Latest failure: {warehouse.failures[0]?.failureCode ?? warehouse.failures[0]?.status}</div>
              ) : null}
            </SectionCard>
          ) : null}

          {user?.isPlatformAdmin &&
          connectorInstances.some((c) => c.connectorDefinitionId === "conn_microsoft_365") ? (
            <Microsoft365AdminPanel companySlug={company.slug} />
          ) : null}
        </div>
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
        <div className="stack">
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

          {user?.isPlatformAdmin ? (
            <SectionCard
              title="Xero test artefact cleanup"
              description="Preview only — DRAFT records with INFRA test prefixes. Deletion requires operator confirmation via Action Engine."
            >
              {tabDataLoading ? (
                <LoadingState label="Loading cleanup manifest…" />
              ) : !testArtefacts ? (
                <EmptyState title="Manifest unavailable" description="Connect Xero or reload to generate the cleanup manifest." />
              ) : (
                <>
                  <Notice tone="info">{testArtefacts.note}</Notice>
                  {testArtefacts.artefacts.length === 0 ? (
                    <EmptyState title="No matching test artefacts" description={`Prefix: ${testArtefacts.prefix}`} />
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Reference</th>
                            <th>Status</th>
                            <th>Amount</th>
                            <th>Recommended</th>
                          </tr>
                        </thead>
                        <tbody>
                          {testArtefacts.artefacts.map((row) => (
                            <tr key={row.xeroId}>
                              <td>{row.reference ?? row.invoiceNumber ?? row.xeroId}</td>
                              <td><StatusBadge status={row.status ?? "unknown"} /></td>
                              <td>{row.amount != null ? formatCurrency(Math.round(row.amount * 100), currency) : "—"}</td>
                              <td>{row.recommendedCleanup ?? "report_only"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      <Modal
        open={Boolean(lifecycleModal)}
        onClose={() => setLifecycleModal(null)}
        title={
          lifecycleModal?.action === "delete"
            ? "Delete company"
            : lifecycleModal?.action === "suspend"
              ? "Suspend company"
              : lifecycleModal?.action === "archive"
                ? "Archive company"
                : "Reactivate company"
        }
        description={
          lifecycleModal?.action === "delete"
            ? "Hard deletion is only allowed for empty test companies with no ledger or usage history."
            : lifecycleModal?.action === "suspend"
              ? "Suspension blocks customer access and chargeable operations. Data, wallet, and audit history are preserved."
              : lifecycleModal?.action === "archive"
                ? "Archived companies are hidden from active lists but retain all history."
                : "Restore this company to active status."
        }
      >
        {lifecycleModal ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void applyLifecycle();
            }}
            className="stack"
          >
            {lifecycleModal.action !== "delete" && lifecycleModal.action !== "reactivate" ? (
              <label className="field">
                <span>Reason</span>
                <textarea
                  value={lifecycleModal.reason}
                  onChange={(e) =>
                    setLifecycleModal({ ...lifecycleModal, reason: e.target.value })
                  }
                  rows={2}
                  placeholder="Optional reason for audit log"
                />
              </label>
            ) : null}
            {lifecycleModal.action === "delete" ? (
              <Notice tone="warning">
                This cannot be undone. Companies with billing or usage history must be archived
                instead.
              </Notice>
            ) : null}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={() => setLifecycleModal(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={lifecycleModal.action === "delete" ? "danger" : "primary"}
                loading={busy}
              >
                Confirm
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
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
