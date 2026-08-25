import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import type { ConnectorInstance, McpEnvironment } from "@infra/shared";
import { api } from "../api";
import {
  ErrorState,
  HealthIndicator,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
} from "../components";
import { formatRelativeTime } from "../lib/format";

type ServiceStatus = "operational" | "degraded" | "unavailable" | "not_configured" | "unknown";

type ServiceTile = {
  id: string;
  name: string;
  status: ServiceStatus;
  detail: string;
};

export default function SystemHealthPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceTile[]>([]);
  const [mcps, setMcps] = useState<McpEnvironment[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInstance[]>([]);
  const [stripeConfigured, setStripeConfigured] = useState<boolean | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [healthResult, readyResult, gatewayResult, mcpList, connectorList] = await Promise.all([
        api.getHealth().then(
          (data) => ({ ok: true as const, data }),
          (err) => ({ ok: false as const, error: err instanceof Error ? err.message : "API unreachable" }),
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
      ]);

      setMcps(mcpList);
      setConnectors(connectorList);
      setCheckedAt(new Date().toISOString());

      const tiles: ServiceTile[] = [];

      if (healthResult.ok) {
        tiles.push({
          id: "api",
          name: "API",
          status: healthResult.data.status === "ok" ? "operational" : "degraded",
          detail: healthResult.data.environment
            ? `Environment: ${healthResult.data.environment}`
            : "Responding",
        });
        tiles.push({
          id: "database",
          name: "D1",
          status: readyResult.ok && readyResult.data.status === "ready" ? "operational" : "degraded",
          detail: readyResult.ok
            ? `Probe: ${readyResult.data.checks?.d1 ?? readyResult.data.status}`
            : "Ready probe unavailable",
        });
        tiles.push({
          id: "frontend",
          name: "Frontend",
          status: "operational",
          detail: "This console loaded successfully",
        });
      } else {
        tiles.push({
          id: "api",
          name: "API",
          status: "unavailable",
          detail: healthResult.error,
        });
        tiles.push({
          id: "database",
          name: "Database",
          status: "unknown",
          detail: "Cannot verify while API is unavailable",
        });
      }

      tiles.push({
        id: "auth",
        name: "Authentication",
        status: healthResult.ok ? "operational" : "unknown",
        detail: healthResult.ok
          ? "Session endpoints reachable via authenticated console"
          : "Unknown while API is down",
      });

      if (gatewayResult.ok) {
        const configured = Boolean(gatewayResult.data.stripeConfigured);
        setStripeConfigured(configured);
        tiles.push({
          id: "billing",
          name: "Billing",
          status: configured ? "not_configured" : "not_configured",
          detail: configured
            ? "Stripe credentials present — live charging not approved"
            : "Stripe is not configured — top-ups unavailable",
        });
        tiles.push({
          id: "gateway",
          name: "AI Gateway",
          status: gatewayResult.data.status === "ok" ? "operational" : "degraded",
          detail: gatewayResult.data.service ?? "Gateway health endpoint responding",
        });
      } else {
        setStripeConfigured(null);
        tiles.push({
          id: "billing",
          name: "Billing",
          status: "unknown",
          detail: "Gateway health endpoint unavailable",
        });
        tiles.push({
          id: "gateway",
          name: "AI Gateway",
          status: "unavailable",
          detail: "Gateway health endpoint did not respond",
        });
      }

      setServices(tiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load system health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingState label="Checking system health…" />;
  if (error) {
    return <ErrorState title="Unable to load system health" description={error} onRetry={() => void load()} />;
  }

  const unhealthyServices = services.filter((s) =>
    ["unavailable", "degraded"].includes(s.status),
  );
  const unhealthyMcps = mcps.filter((m) => ["unreachable", "degraded"].includes(m.status));
  const attentionConnectors = connectors.filter((c) => {
    const auth = c.authStatus ?? "not_configured";
    return (
      auth === "auth_expired" ||
      auth === "rotation_required" ||
      c.status === "error" ||
      c.status === "degraded"
    );
  });
  const platformOk = unhealthyServices.length === 0;

  return (
    <>
      <PageHeader
        title="System Health"
        description="Platform services vs customer integration health — one broken connector does not mean INFRA is offline."
        actions={
          <button type="button" className="button button-secondary" onClick={() => void load()}>
            Refresh
          </button>
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
            {unhealthyMcps.length > 0
              ? ` ${unhealthyMcps.length} customer MCP(s) need attention — see Customer integrations below.`
              : ""}
            {stripeConfigured === false ? " Stripe billing is not configured." : ""}
          </p>
        </div>
      </div>

      <SectionCard title="Platform health" description="INFRA control plane — shared across all tenants.">
        <div className="grid grid-3" style={{ marginBottom: 0 }}>
          {services.map((service) => (
            <div key={service.id} className="card">
              <div className="connection-header">
                <h3 style={{ margin: 0, fontSize: "var(--text-md)" }}>{service.name}</h3>
                <HealthIndicator status={service.status} />
              </div>
              <p className="muted small" style={{ margin: "8px 0 0" }}>
                {service.detail}
              </p>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <SectionCard
          title="Customer integrations — Business MCPs"
          description="Per-company gateways. Degraded MCP affects one tenant, not platform uptime."
        >
          {mcps.length === 0 ? (
            <p className="muted">No gateways registered.</p>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {mcps.map((mcp) => (
                <div key={mcp.id} className="connection-header" style={{ marginBottom: 0 }}>
                  <div>
                    <strong>{mcp.name}</strong>
                    <div className="muted small">
                      {mcp.lastHealthCheckAt
                        ? `Checked ${formatRelativeTime(mcp.lastHealthCheckAt)}`
                        : "Never checked"}
                      {mcp.lastLatencyMs != null ? ` · ${mcp.lastLatencyMs}ms` : ""}
                    </div>
                  </div>
                  <StatusBadge status={mcp.status} />
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Customer integrations — Connectors"
          description="Auth and sync health per company. Draft/not configured is normal."
        >
          {connectors.length === 0 ? (
            <p className="muted">No connector instances.</p>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {connectors.map((c) => (
                <div key={c.id} className="connection-header" style={{ marginBottom: 0 }}>
                  <div>
                    <strong>{c.name}</strong>
                    <div className="muted small">
                      {(c.authStatus ?? "not_configured") === "auth_expired"
                        ? "Authentication expired"
                        : c.status === "draft"
                          ? "Not connected"
                          : c.lastSyncAt
                            ? `Last sync ${formatDate(c.lastSyncAt)}`
                            : c.authStatus === "connected"
                              ? "Connected"
                              : "Requires setup"}
                    </div>
                  </div>
                  <StatusBadge
                    status={
                      (c.authStatus ?? "not_configured") === "auth_expired"
                        ? "error"
                        : c.status === "draft"
                          ? "not_configured"
                          : c.status
                    }
                    label={c.status === "draft" ? "Not connected" : undefined}
                  />
                </div>
              ))}
              {attentionConnectors.length > 0 ? (
                <p className="muted small">
                  {attentionConnectors.length} connector(s) need attention
                </p>
              ) : (
                <p className="muted small">No connector auth or health alerts</p>
              )}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="What we do not claim" description="Trust requires honesty.">
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>No health cron is reported unless a scheduler endpoint exists.</li>
          <li>Stripe webhook delivery is not probed independently.</li>
          <li>Queue depth is not displayed without a real queue metric.</li>
          <li>Database health is unknown without a dedicated probe.</li>
        </ul>
      </SectionCard>
    </>
  );
}
