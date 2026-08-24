import { MOCK_SYSTEM_HEALTH } from "../mock-data";
import { PageHeader, SectionCard, StatusBadge } from "../components";

export default function SystemHealthPage() {
  const h = MOCK_SYSTEM_HEALTH;

  return (
    <>
      <PageHeader
        title="System Health"
        subtitle="Control plane infrastructure and registered environment health."
      />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>API</h3>
          <StatusBadge value={h.api.status} />
          <div className="muted">{h.api.latencyMs}ms</div>
        </div>
        <div className="card metric-card">
          <h3>Database</h3>
          <StatusBadge value={h.database.status} />
          <div className="muted">{h.database.latencyMs}ms</div>
        </div>
        <div className="card metric-card">
          <h3>Stripe webhooks</h3>
          <StatusBadge value={h.stripeWebhooks.status} />
        </div>
        <div className="card metric-card">
          <h3>Health cron</h3>
          <StatusBadge value={h.healthCron.status} />
        </div>
      </div>

      <div className="grid grid-2">
        <SectionCard title="MCP environments">
          <p>
            Healthy: {h.mcpEnvironments.healthy} · Degraded:{" "}
            {h.mcpEnvironments.degraded} · Unreachable:{" "}
            {h.mcpEnvironments.unreachable}
          </p>
        </SectionCard>

        <SectionCard title="Connectors">
          <p>
            Healthy: {h.connectors.healthy} · Error: {h.connectors.error} · Draft:{" "}
            {h.connectors.draft}
          </p>
        </SectionCard>

        <SectionCard title="Queue depth">
          <div className="metric">{h.queueDepth}</div>
          <p className="muted">No pending async jobs</p>
        </SectionCard>
      </div>
    </>
  );
}
