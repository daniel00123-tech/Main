import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import type { Company, ConnectorInstance, McpEnvironment } from "@infra/shared";
import { api } from "../api";
import {
  Button,
  Drawer,
  ErrorState,
  LoadingState,
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
      const [healthResult, readyResult, gatewayResult, mcpList, connectorList, companyList] =
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
        ]);

      setMcps(mcpList);
      setConnectors(connectorList);
      setCompanies(companyList);
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

      if (gatewayResult.ok) {
        const configured = Boolean(gatewayResult.data.stripeConfigured);
        setStripeConfigured(configured);
        rows.push({
          id: "billing",
          name: "Billing",
          status: configured ? "degraded" : "not_configured",
          detail: configured
            ? "Stripe configured — live charging not approved"
            : "Stripe not configured",
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
  const platformOk = unhealthyServices.length === 0;

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
        title="System Health"
        description="Platform services vs customer integration health."
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
            {platformOk ? "Platform services operational" : "Platform attention required"}
          </p>
          <p>
            Last checked {checkedAt ? formatRelativeTime(checkedAt) : "—"}.
            {stripeConfigured === false ? " Stripe billing is not configured." : ""}
          </p>
        </div>
      </div>

      <SectionCard title="Platform health">
        <div className="table-wrap health-console">
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
        <p className="muted small" style={{ marginTop: 8 }}>
          {services.map((s) => `${s.name}: ${s.detail}`).join(" · ")}
        </p>
      </SectionCard>

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
            <div className="drawer-row">
              <dt>Connector ID</dt>
              <dd className="mono small">{connectorDetail.connector.id}</dd>
            </div>
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
