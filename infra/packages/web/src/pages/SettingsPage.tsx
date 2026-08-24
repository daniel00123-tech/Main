import { useEffect, useState } from "react";
import { api, API_BASE } from "../api";
import { ErrorState, LoadingState, Notice, PageHeader, SectionCard, StatusBadge } from "../components";

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiHealth, setApiHealth] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  const [stripeConfigured, setStripeConfigured] = useState<boolean | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [health, readyResult, gateway] = await Promise.all([
        api.getHealth(),
        api.getReady().catch(() => null),
        api.getGatewayHealth().catch(() => null),
      ]);
      setApiHealth(health.status);
      setReady(readyResult?.status ?? null);
      setStripeConfigured(gateway ? Boolean(gateway.stripeConfigured) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingState label="Loading settings…" />;
  if (error) {
    return <ErrorState title="Unable to load settings" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Live platform probes. Most configuration is not editable from this screen yet."
      />

      <div className="stack">
        <SectionCard title="Environment" description="What this console is talking to.">
          <div className="drawer-row">
            <dt>Product</dt>
            <dd>INFRA</dd>
          </div>
          <div className="drawer-row">
            <dt>API</dt>
            <dd>
              <StatusBadge
                status={apiHealth === "ok" ? "healthy" : "unknown"}
                label={apiHealth === "ok" ? "Responding" : apiHealth ?? "Unknown"}
              />
            </dd>
          </div>
          <div className="drawer-row">
            <dt>Database</dt>
            <dd>
              <StatusBadge
                status={ready === "ready" ? "healthy" : ready ? "degraded" : "unknown"}
                label={ready === "ready" ? "Ready" : ready ?? "No /ready probe"}
              />
            </dd>
          </div>
          <div className="drawer-row">
            <dt>API base</dt>
            <dd className="mono">{API_BASE || "(same origin)"}</dd>
          </div>
        </SectionCard>

        <SectionCard title="Security" description="Enforced by the API, not toggled here.">
          <Notice tone="info">
            Session cookies, tenant isolation, MCP authentication, and audit logging are always on.
            There is no UI switch to disable them.
          </Notice>
        </SectionCard>

        <SectionCard title="Payments" description="Stripe is prepared but not live.">
          <div className="drawer-row">
            <dt>Card payments</dt>
            <dd>
              <StatusBadge
                status={stripeConfigured ? "configured" : "not_configured"}
                label={stripeConfigured ? "Credentials present — not approved live" : "Not configured"}
              />
            </dd>
          </div>
        </SectionCard>

        <SectionCard title="Coming soon">
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Domains and branding</li>
            <li>Notification preferences</li>
            <li>SSO / identity providers</li>
          </ul>
        </SectionCard>
      </div>
    </>
  );
}
