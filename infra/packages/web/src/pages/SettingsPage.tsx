import { useEffect, useState } from "react";
import { api, API_BASE } from "../api";
import {
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";

type SettingsTab =
  | "general"
  | "branding"
  | "domains"
  | "notifications"
  | "security"
  | "billing"
  | "integrations"
  | "data"
  | "platform"
  | "whitelabel";

const TABS: Array<{ id: SettingsTab; label: string; available: boolean }> = [
  { id: "general", label: "General", available: true },
  { id: "branding", label: "Branding", available: false },
  { id: "domains", label: "Domains", available: false },
  { id: "notifications", label: "Notifications", available: false },
  { id: "security", label: "Security", available: true },
  { id: "billing", label: "Billing & payments", available: true },
  { id: "integrations", label: "AI & integrations", available: false },
  { id: "data", label: "Data & retention", available: false },
  { id: "platform", label: "Platform", available: true },
  { id: "whitelabel", label: "White labelling", available: false },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiHealth, setApiHealth] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  const [stripeConfigured, setStripeConfigured] = useState<boolean | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);

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
      setEnvironment(health.environment ?? null);
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
    return (
      <ErrorState title="Unable to load settings" description={error} onRetry={() => void load()} />
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Platform configuration. Only settings with backend support are editable."
      />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item${tab === item.id ? " active" : ""}${!item.available ? " disabled" : ""}`}
              onClick={() => item.available && setTab(item.id)}
              disabled={!item.available}
              title={item.available ? undefined : "Coming soon"}
            >
              {item.label}
              {!item.available ? " (soon)" : ""}
            </button>
          ))}
        </nav>

        <div>
          {tab === "general" ? (
            <SectionCard title="General">
              <div className="drawer-row">
                <dt>Platform display name</dt>
                <dd>Infra</dd>
              </div>
              <div className="drawer-row">
                <dt>Default currency</dt>
                <dd>GBP</dd>
              </div>
              <div className="drawer-row">
                <dt>Default timezone</dt>
                <dd>Europe/London</dd>
              </div>
              <Notice tone="info">
                Editable general settings will persist here once a platform settings store is
                implemented.
              </Notice>
            </SectionCard>
          ) : null}

          {tab === "security" ? (
            <SectionCard title="Security" description="Immutable protections enforced by the API.">
              <div className="stack" style={{ gap: 12 }}>
                <div className="drawer-row">
                  <dt>Session security</dt>
                  <dd>
                    <StatusBadge status="healthy" label="Enforced" />
                  </dd>
                </div>
                <div className="drawer-row">
                  <dt>Tenant isolation</dt>
                  <dd>
                    <StatusBadge status="healthy" label="Always on" />
                  </dd>
                </div>
                <div className="drawer-row">
                  <dt>Audit logging</dt>
                  <dd>
                    <StatusBadge status="healthy" label="Always on" />
                  </dd>
                </div>
                <div className="drawer-row">
                  <dt>MCP authentication</dt>
                  <dd>
                    <StatusBadge status="healthy" label="Required" />
                  </dd>
                </div>
                <div className="drawer-row">
                  <dt>Admin access</dt>
                  <dd>
                    <StatusBadge status="healthy" label="Platform admin role" />
                  </dd>
                </div>
                <div className="drawer-row">
                  <dt>MFA / SSO</dt>
                  <dd>
                    <StatusBadge status="not_configured" label="Not configured" />
                  </dd>
                </div>
              </div>
              <Notice tone="info">
                There are no UI switches to disable tenant isolation or audit logging.
              </Notice>
            </SectionCard>
          ) : null}

          {tab === "billing" ? (
            <SectionCard title="Billing & payments">
              <div className="drawer-row">
                <dt>Payment mode</dt>
                <dd>
                  <StatusBadge status="warning" label="Test / not live" />
                </dd>
              </div>
              <div className="drawer-row">
                <dt>Stripe connection</dt>
                <dd>
                  <StatusBadge
                    status={stripeConfigured ? "healthy" : "not_configured"}
                    label={stripeConfigured ? "Connected" : "Not connected"}
                  />
                </dd>
              </div>
              <div className="drawer-row">
                <dt>Live payments</dt>
                <dd>
                  <StatusBadge status="not_configured" label="Not approved" />
                </dd>
              </div>
              <div className="drawer-row">
                <dt>Webhook</dt>
                <dd>
                  <StatusBadge
                    status={stripeConfigured ? "healthy" : "not_configured"}
                    label={stripeConfigured ? "Configured" : "Not configured"}
                  />
                </dd>
              </div>
              <Notice tone="info">
                Stripe secret keys are never displayed in the Admin Control Panel.
              </Notice>
            </SectionCard>
          ) : null}

          {tab === "platform" ? (
            <SectionCard title="Platform environment">
              <div className="drawer-row">
                <dt>Product</dt>
                <dd>Infra</dd>
              </div>
              <div className="drawer-row">
                <dt>Environment</dt>
                <dd>{environment ?? "Unknown"}</dd>
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
                    status={ready === "ready" ? "healthy" : ready ? "warning" : "unknown"}
                    label={ready === "ready" ? "Ready" : ready ?? "No probe"}
                  />
                </dd>
              </div>
              <div className="drawer-row">
                <dt>API base</dt>
                <dd className="mono">{API_BASE || "(same origin)"}</dd>
              </div>
            </SectionCard>
          ) : null}

          {["branding", "domains", "notifications", "integrations", "data", "whitelabel"].includes(
            tab,
          ) ? (
            <SectionCard title={TABS.find((t) => t.id === tab)?.label ?? "Settings"}>
              <Notice tone="info">
                This section is prepared for future configuration. Backend persistence is not yet
                available — controls will appear here when safe to implement.
              </Notice>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </>
  );
}
