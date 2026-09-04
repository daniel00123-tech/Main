import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import type { Company, ConnectorInstance, McpEnvironment } from "@infra/shared";
import { api } from "../api";
import {
  Button,
  CollapsibleBlock,
  DataCard,
  Drawer,
  ErrorState,
  LoadingState,
  MobileRecordList,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
} from "../components";
import { formatRelativeTime, humanStatus } from "../lib/format";

type ServiceStatus = "operational" | "degraded" | "unavailable" | "not_configured" | "unknown";

type ServiceRow = {
  id: string;
  name: string;
  status: ServiceStatus;
  detail: string;
  latency?: string;
  lastCheck: string;
};

function mapServiceStatus(status: ServiceStatus): string {
  if (status === "operational") return "healthy";
  if (status === "degraded") return "warning";
  if (status === "unavailable") return "failed";
  return "not_configured";
}

export default function SystemHealthPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [mcps, setMcps] = useState<McpEnvironment[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInstance[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [stripeConfigured, setStripeConfigured] = useState<boolean | null>(null);
  const [opsHealth, setOpsHealth] = useState<Awaited<
    ReturnType<typeof api.getPlatformOperationsHealth>
  > | null>(null);
  const [whatsappUx, setWhatsappUx] = useState<Awaited<ReturnType<typeof api.getWhatsAppInbox>> | null>(null);
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set());
  const [connectorDetail, setConnectorDetail] = useState<{
    connector: ConnectorInstance;
    companyName: string;
  } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const now = new Date().toISOString();
    try {
      const [healthResult, readyResult, gatewayResult, mcpList, connectorList, companyList, opsResult, inbox, warehouseResult] =
        await Promise.all([
          api.getHealth().then(
            (data) => ({ ok: true as const, data }),
            (err) => ({
              ok: false as const,
              error: err instanceof Error ? err.message : "API unreachable",
            }),
          ),
          api.getReady().then(
            (data) => ({ ok: true as const, data }),
            () => ({ ok: false as const }),
          ),
          api.getGatewayHealth().then(
            (data) => ({ ok: true as const, data }),
            () => ({ ok: false as const }),
          ),
          api.getMcpEnvironments().catch(() => [] as McpEnvironment[]),
          api.getConnectorInstances().catch(() => [] as ConnectorInstance[]),
          api.getCompanies().catch(() => [] as Company[]),
          api.getPlatformOperationsHealth().catch(() => null),
          api.getWhatsAppInbox().catch(() => null),
          api.getWarehouse("co_el").catch(() => null),
        ]);

      setWhatsappUx(inbox);
      setMcps(mcpList);
      setConnectors(connectorList);
      setCompanies(companyList);
      setOpsHealth(opsResult);
      setCheckedAt(now);

      const rows: ServiceRow[] = [];
      const lastCheck = "Just now";

      if (healthResult.ok) {
        rows.push({
          id: "api",
          name: "API",
          status: healthResult.data.status === "ok" ? "operational" : "degraded",
          detail: healthResult.data.environment ?? "Responding",
          lastCheck,
        });
        rows.push({
          id: "database",
          name: "Database",
          status:
            readyResult.ok && readyResult.data.status === "ready" ? "operational" : "degraded",
          detail: readyResult.ok
            ? String(readyResult.data.checks?.d1 ?? readyResult.data.status)
            : "Ready probe unavailable",
          lastCheck,
        });
        rows.push({
          id: "frontend",
          name: "Frontend",
          status: "operational",
          detail: "Console loaded",
          lastCheck,
        });
      } else {
        rows.push({
          id: "api",
          name: "API",
          status: "unavailable",
          detail: healthResult.error,
          lastCheck,
        });
      }

      rows.push({
        id: "auth",
        name: "Authentication",
        status: healthResult.ok ? "operational" : "unknown",
        detail: healthResult.ok ? "Session endpoints reachable" : "Unknown while API is down",
        lastCheck,
      });

      const wh = warehouseResult && "warehouse" in warehouseResult ? warehouseResult.warehouse : null;
      rows.push({
        id: "xero_warehouse",
        name: "EL Xero Warehouse",
        status:
          !wh || wh.status === "NEVER_SYNCED"
            ? "not_configured"
            : wh.status === "HEALTHY" || wh.status === "COMPLETE"
              ? "operational"
              : wh.status === "BACKFILLING" || wh.status === "PARTIAL"
                ? "degraded"
                : wh.status === "DEGRADED"
                  ? "degraded"
                  : "unavailable",
        detail: wh
          ? `${wh.status} · complete ${wh.monthsComplete?.length ?? 0} · partial ${wh.monthsPartial?.length ?? 0} · last ${wh.lastSuccessfulSync ?? "never"} · next ${wh.nextScheduledSync}`
          : "Warehouse status unavailable",
        lastCheck,
      });

      if (gatewayResult.ok) {
        const configured = Boolean(gatewayResult.data.stripeConfigured);
        setStripeConfigured(configured);
        const billingOpenExceptions = opsResult?.openFinancialExceptions ?? 0;
        rows.push({
          id: "billing",
          name: "Billing",
          status: !configured
            ? "not_configured"
            : billingOpenExceptions > 0
              ? "degraded"
              : "operational",
          detail: !configured
            ? "Stripe not configured"
            : billingOpenExceptions > 0
              ? `${billingOpenExceptions} open financial exception(s) — review reconciliation`
              : "Stripe configured — no open financial exceptions",
          lastCheck,
        });
        rows.push({
          id: "gateway",
          name: "AI Gateway",
          status: gatewayResult.data.status === "ok" ? "operational" : "degraded",
          detail: gatewayResult.data.service ?? "Gateway responding",
          latency: "—",
          lastCheck,
        });
      } else {
        setStripeConfigured(null);
        rows.push({
          id: "billing",
          name: "Billing",
          status: "unknown",
          detail: "Gateway health unavailable",
          lastCheck,
        });
        rows.push({
          id: "gateway",
          name: "AI Gateway",
          status: "unavailable",
          detail: "Gateway health endpoint did not respond",
          lastCheck,
        });
      }

      setServices(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load system health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const companyById = useMemo(
    () => new Map(companies.map((c) => [c.id, c])),
    [companies],
  );

  const connectorsByCompany = useMemo(() => {
    const map = new Map<
      string,
      { companyName: string; connected: ConnectorInstance[]; notConfigured: ConnectorInstance[] }
    >();
    for (const connector of connectors) {
      const company = companyById.get(connector.companyId);
      const companyName = company?.name ?? connector.companyId;
      const entry = map.get(connector.companyId) ?? {
        companyName,
        connected: [],
        notConfigured: [],
      };
      const auth = connector.authStatus ?? "not_configured";
      const isConfigured =
        connector.status !== "draft" &&
        auth !== "not_configured" &&
        auth !== "credentials_required";
      if (isConfigured) entry.connected.push(connector);
      else entry.notConfigured.push(connector);
      map.set(connector.companyId, entry);
    }
    return map;
  }, [connectors, companyById]);

  const unhealthyServices = services.filter((s) =>
    ["unavailable", "degraded"].includes(s.status),
  );
  const platformOk =
    opsHealth?.overallState === "HEALTHY" ||
    (opsHealth == null && unhealthyServices.length === 0);

  function mapOpsState(state: string): string {
    if (state === "HEALTHY") return "healthy";
    if (state === "DEGRADED") return "warning";
    if (state === "ATTENTION_REQUIRED") return "failed";
    if (state === "OUTAGE") return "failed";
    return "not_configured";
  }

  function toggleCompany(companyId: string) {
    setExpandedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  }

  if (loading) return <LoadingState label="Checking system health…" />;
  if (error) {
    return (
      <ErrorState
        title="Unable to load system health"
        description={error}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="System health"
        description="Operational summary first, diagnostics second."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      <div className={`attention-banner ${platformOk ? "ok" : "warn"}`} role="status">
        <Activity size={18} aria-hidden />
        <div>
          <p className="attention-title">
            {platformOk
              ? "Platform operational"
              : opsHealth?.overallState === "OUTAGE"
                ? "Platform outage detected"
                : "Platform attention required"}
          </p>
          <p>
            Last checked {checkedAt ? formatRelativeTime(checkedAt) : "—"}.
            {stripeConfigured === false ? " Stripe billing is not configured." : ""}
          </p>
        </div>
      </div>

      {(() => {
        const healthy = services.filter((s) => s.status === "operational").length;
        const degraded = services.filter((s) => s.status === "degraded").length;
        const failing = services.filter((s) => s.status === "unavailable").length;
        return (
          <div className="health-summary">
            <div>
              <span className="muted small">Healthy</span>
              <strong>{healthy}</strong>
            </div>
            <div>
              <span className="muted small">Degraded</span>
              <strong>{degraded}</strong>
            </div>
            <div>
              <span className="muted small">Failing</span>
              <strong>{failing}</strong>
            </div>
            <div>
              <span className="muted small">Services</span>
              <strong>{services.length}</strong>
            </div>
          </div>
        );
      })()}

      {unhealthyServices.length > 0 ? (
        <SectionCard title="Needs attention" description="Resolve these before treating the platform as healthy.">
          <MobileRecordList>
            {unhealthyServices.map((service) => (
              <DataCard
                key={`attn-${service.id}`}
                title={service.name}
                subtitle={service.detail}
                status={
                  <StatusBadge
                    status={mapServiceStatus(service.status)}
                    label={humanStatus(mapServiceStatus(service.status))}
                  />
                }
                timestamp={service.lastCheck}
              />
            ))}
          </MobileRecordList>
        </SectionCard>
      ) : null}

      <SectionCard title="Platform services">
        <div className="mobile-cards">
          <MobileRecordList>
            {services.map((service) => (
              <DataCard
                key={service.id}
                title={service.name}
                subtitle={service.detail}
                status={
                  <StatusBadge
                    status={mapServiceStatus(service.status)}
                    label={humanStatus(mapServiceStatus(service.status))}
                  />
                }
                metric={service.latency ?? undefined}
                timestamp={service.lastCheck}
              />
            ))}
          </MobileRecordList>
        </div>
        <div className="desktop-table table-wrap health-console">
          <table className="table compact">
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>Last check</th>
                <th className="num">Latency</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.id}>
                  <td>{service.name}</td>
                  <td className="status-cell">
                    <StatusBadge
                      status={mapServiceStatus(service.status)}
                      label={humanStatus(mapServiceStatus(service.status))}
                    />
                  </td>
                  <td className="muted">{service.lastCheck}</td>
                  <td className="num muted">{service.latency ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {whatsappUx?.metrics ? (
        <SectionCard
          title="WhatsApp realtime UX"
          description="Recognised-user first-visible and final latency, silent/stuck counts, read and typing success."
          className="mt-6"
        >
          {whatsappUx.metrics.healthState === "RED" ? (
            <div className="attention-banner warn" style={{ marginBottom: 12 }}>
              <p className="attention-title">WhatsApp UX RED</p>
              <p className="muted small">{(whatsappUx.metrics.redReasons ?? []).join(" · ") || "Greeting or recognised-user first visible exceeded 3s, queue oldest >10s, or a WhatsApp DLQ event."}</p>
            </div>
          ) : null}
          <div className="metric-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
            <DataCard title="Recognised" metric={String(whatsappUx.metrics.recognisedMessages)} />
            <DataCard title="First visible p50/p95" metric={`${whatsappUx.metrics.firstVisibleP50Ms ?? "—"} / ${whatsappUx.metrics.firstVisibleP95Ms ?? "—"} ms`} />
            <DataCard title="Final p50/p95" metric={`${whatsappUx.metrics.finalP50Ms ?? "—"} / ${whatsappUx.metrics.finalP95Ms ?? "—"} ms`} />
            <DataCard title="Health" metric={whatsappUx.metrics.healthState ?? "—"} />
            <DataCard title="Silent >3s / >10s" metric={`${whatsappUx.metrics.silentOver3s} / ${whatsappUx.metrics.silentOver10s}`} />
            <DataCard title="Greeting silent >3s" metric={String(whatsappUx.metrics.greetingSilentOver3s ?? 0)} />
            <DataCard title="Stuck >30s" metric={String(whatsappUx.metrics.stuckOver30s)} />
            <DataCard title="Ack no final >30s" metric={String(whatsappUx.metrics.ackWithoutFinalOver30s ?? 0)} />
            <DataCard title="Knowledge circuit" metric={String(whatsappUx.metrics.knowledgeCircuitOpen ?? 0)} />
            <DataCard title="DLQ / persist fail" metric={`${whatsappUx.metrics.dlqEvents ?? 0} / ${whatsappUx.metrics.persistFailures ?? 0}`} />
            <DataCard title="Failed outbound" metric={String(whatsappUx.metrics.failedOutbound)} />
            <DataCard title="Queue p50" metric={whatsappUx.metrics.queueLatencyP50Ms == null ? "—" : `${whatsappUx.metrics.queueLatencyP50Ms} ms`} />
            <DataCard title="Queue oldest" metric={whatsappUx.metrics.queueOldestMs == null ? "—" : `${whatsappUx.metrics.queueOldestMs} ms`} />
            <DataCard title="Live Meta inbound" metric={String(whatsappUx.metrics.liveMetaInbound ?? 0)} />
            <DataCard title="Typing / read" metric={`${whatsappUx.metrics.typingSuccessRate ?? "—"}% / ${whatsappUx.metrics.readStatusSuccessRate ?? "—"}%`} />
          </div>
        </SectionCard>
      ) : null}

      {opsHealth ? (
        <>
          <SectionCard title="Operational subsystems" className="mt-6">
            <div className="mobile-cards">
              <MobileRecordList>
                {opsHealth.subsystems.map((subsystem) => (
                  <DataCard
                    key={subsystem.id}
                    title={subsystem.label}
                    subtitle={subsystem.summary}
                    status={
                      <StatusBadge
                        status={mapOpsState(subsystem.state)}
                        label={subsystem.state.replace(/_/g, " ")}
                      />
                    }
                  />
                ))}
              </MobileRecordList>
            </div>
            <div className="desktop-table table-wrap health-console">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Subsystem</th>
                    <th>State</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {opsHealth.subsystems.map((subsystem) => (
                    <tr key={subsystem.id}>
                      <td>{subsystem.label}</td>
                      <td className="status-cell">
                        <StatusBadge
                          status={mapOpsState(subsystem.state)}
                          label={subsystem.state.replace(/_/g, " ")}
                        />
                      </td>
                      <td className="muted">{subsystem.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {opsHealth.schedulerHeartbeats.length > 0 ? (
            <SectionCard title="Scheduled jobs" className="mt-6">
              <div className="table-wrap health-console">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>State</th>
                      <th>Last success</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opsHealth.schedulerHeartbeats.map((hb) => (
                      <tr key={hb.key}>
                        <td>{hb.label}</td>
                        <td className="status-cell">
                          <StatusBadge
                            status={mapOpsState(hb.state)}
                            label={hb.state.replace(/_/g, " ")}
                          />
                        </td>
                        <td className="muted">
                          {hb.lastSuccessAt ? formatRelativeTime(hb.lastSuccessAt) : "—"}
                        </td>
                        <td className="muted">{hb.lastError ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>
                Automation processing: {opsHealth.automationProcessingMode.replace(/_/g, " ")}
              </p>
            </SectionCard>
          ) : null}

          {opsHealth.incidents.length > 0 ? (
            <SectionCard title="Open operational incidents" className="mt-6">
              <div className="table-wrap health-console">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Company</th>
                      <th>Issue</th>
                      <th>Occurrences</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opsHealth.incidents.slice(0, 20).map((incident) => (
                      <tr key={incident.id}>
                        <td className="status-cell">
                          <StatusBadge
                            status={
                              incident.severity === "CRITICAL"
                                ? "failed"
                                : incident.severity === "WARNING"
                                  ? "warning"
                                  : "healthy"
                            }
                            label={incident.severity}
                          />
                        </td>
                        <td>{incident.companyName ?? "Platform"}</td>
                        <td>
                          <div>{incident.title}</div>
                          <div className="muted small">{incident.summary}</div>
                        </td>
                        <td className="num">{incident.occurrenceCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ) : null}
        </>
      ) : null}

      <SectionCard
        title="Customer integrations — Business MCPs"
        description="Per-company gateways. One degraded MCP affects one tenant."
        className="mt-6"
      >
        {mcps.length === 0 ? (
          <p className="muted">No gateways registered.</p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Gateway</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Last check</th>
                  <th className="num">Latency</th>
                </tr>
              </thead>
              <tbody>
                {mcps.map((mcp) => (
                  <tr key={mcp.id}>
                    <td>{mcp.name}</td>
                    <td className="muted">
                      {companyById.get(mcp.companyId)?.name ?? mcp.companyId}
                    </td>
                    <td>
                      <StatusBadge status={mcp.status} />
                    </td>
                    <td className="muted">
                      {mcp.lastHealthCheckAt
                        ? formatRelativeTime(mcp.lastHealthCheckAt)
                        : "Never"}
                    </td>
                    <td className="num">
                      {mcp.lastLatencyMs != null ? `${mcp.lastLatencyMs}ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Customer integrations — Connectors"
        description="Grouped by company. Not configured is normal — not unhealthy."
        className="mt-6"
      >
        {connectorsByCompany.size === 0 ? (
          <p className="muted">No connector instances.</p>
        ) : (
          [...connectorsByCompany.entries()].map(([companyId, group]) => {
            const expanded = expandedCompanies.has(companyId);
            const hasIssue = group.connected.some(
              (c) =>
                c.status === "error" ||
                c.status === "degraded" ||
                c.authStatus === "auth_expired",
            );
            return (
              <div key={companyId} className="connector-group">
                <div
                  className="connector-group-header"
                  onClick={() => toggleCompany(companyId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") toggleCompany(companyId);
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <strong>{group.companyName}</strong>
                    <StatusBadge
                      status={hasIssue ? "warning" : "healthy"}
                      label={hasIssue ? "Attention required" : "Healthy"}
                    />
                  </div>
                  <span className="muted small">
                    {group.connected.length} connected · {group.notConfigured.length} not
                    configured
                  </span>
                </div>
                {expanded ? (
                  <div className="connector-group-body">
                    {group.connected.length > 0 ? (
                      <div className="connector-subsection">
                        <div className="connector-subsection-title">Connected</div>
                        {group.connected.map((c) => (
                          <div
                            key={c.id}
                            className="connection-header"
                            style={{ marginBottom: 8, cursor: "pointer" }}
                            onClick={() =>
                              setConnectorDetail({ connector: c, companyName: group.companyName })
                            }
                          >
                            <div>
                              <strong>{c.name}</strong>
                              <div className="muted small">
                                {c.lastSyncAt
                                  ? `Last sync ${formatDate(c.lastSyncAt)}`
                                  : "Connected"}
                              </div>
                            </div>
                            <StatusBadge status={c.status === "error" ? "failed" : c.status} />
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {group.notConfigured.length > 0 ? (
                      <div className="connector-subsection">
                        <div className="connector-subsection-title">
                          Not configured ({group.notConfigured.length})
                        </div>
                        <p className="muted small">
                          {group.notConfigured.map((c) => c.name).join(", ")}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </SectionCard>

      <Drawer
        open={Boolean(connectorDetail)}
        onClose={() => setConnectorDetail(null)}
        title={connectorDetail?.connector.name ?? "Connector diagnostics"}
      >
        {connectorDetail ? (
          <>
            <p className="muted small">{connectorDetail.companyName}</p>
            <div className="drawer-row">
              <dt>Connection status</dt>
              <dd>
                <StatusBadge status={connectorDetail.connector.status} />
              </dd>
            </div>
            <div className="drawer-row">
              <dt>Authentication</dt>
              <dd>
                <StatusBadge
                  status={connectorDetail.connector.authStatus ?? "not_configured"}
                />
              </dd>
            </div>
            <div className="drawer-row">
              <dt>Last sync</dt>
              <dd>
                {connectorDetail.connector.lastSyncAt
                  ? formatDate(connectorDetail.connector.lastSyncAt)
                  : "—"}
              </dd>
            </div>
            <CollapsibleBlock title="Technical details">
              <div className="drawer-row">
                <dt>Connector ID</dt>
                <dd className="mono small">{connectorDetail.connector.id}</dd>
              </div>
            </CollapsibleBlock>
            <p className="muted small" style={{ marginTop: 12 }}>
              Detailed connector request logs are available from Usage and Audit Log filtered by
              company and integration. Credentials are never shown here.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                window.location.href = `/usage?company=${encodeURIComponent(connectorDetail.connector.companyId)}`;
              }}
            >
              View usage logs
            </Button>
          </>
        ) : null}
      </Drawer>
    </>
  );
}
