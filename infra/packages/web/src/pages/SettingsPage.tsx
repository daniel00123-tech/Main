import { PageHeader, SectionCard, Notice } from "../components";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Platform configuration for the INFRA control plane."
      />

      <div className="stack">
        <SectionCard title="General" description="Identity and environment.">
          <div className="drawer-row">
            <dt>Product</dt>
            <dd>INFRA</dd>
          </div>
          <div className="drawer-row">
            <dt>Surface</dt>
            <dd>Control Plane</dd>
          </div>
          <div className="drawer-row">
            <dt>Web</dt>
            <dd className="mono">infra-web.pages.dev</dd>
          </div>
        </SectionCard>

        <SectionCard title="Security" description="Authentication and access controls.">
          <div className="drawer-row">
            <dt>Session auth</dt>
            <dd>
              <span className="badge badge-success">Enabled</span>
            </dd>
          </div>
          <div className="drawer-row">
            <dt>Tenant isolation</dt>
            <dd>
              <span className="badge badge-success">Enforced</span>
            </dd>
          </div>
          <div className="drawer-row">
            <dt>Audit logging</dt>
            <dd>
              <span className="badge badge-success">Enabled</span>
            </dd>
          </div>
          <Notice tone="info">
            Security controls are enforced by the API. Changing these settings from the UI is not
            available yet.
          </Notice>
        </SectionCard>

        <SectionCard title="Billing" description="Payment rail configuration.">
          <Notice tone="info">
            Stripe top-ups are available when API secrets are configured. Customer wallets are managed
            per company. Platform margin analytics stay in the admin Billing view — never in the
            customer wallet.
          </Notice>
        </SectionCard>

        <SectionCard title="Coming soon">
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Domains & branding</li>
            <li>Notification preferences</li>
            <li>Developer API keys management UI</li>
            <li>SSO / identity providers</li>
          </ul>
        </SectionCard>
      </div>
    </>
  );
}
