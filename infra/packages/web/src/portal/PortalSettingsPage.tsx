import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ErrorState,
  KeyValue,
  LoadingState,
  Notice,
  SectionCard,
  StatusBadge,
} from "../components";
import { humanRole } from "../lib/format";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

type SettingsTab =
  | "general"
  | "notifications"
  | "security"
  | "billing"
  | "integrations"
  | "data"
  | "branding"
  | "advanced";

const TABS: Array<{ id: SettingsTab; label: string; available: boolean }> = [
  { id: "general", label: "General", available: true },
  { id: "notifications", label: "Notifications", available: false },
  { id: "security", label: "Security", available: true },
  { id: "billing", label: "Billing", available: true },
  { id: "integrations", label: "AI & integrations", available: true },
  { id: "data", label: "Data & privacy", available: false },
  { id: "branding", label: "Branding", available: false },
  { id: "advanced", label: "Advanced", available: true },
];

export default function PortalSettingsPage() {
  const { company, membership, loading, error } = usePortalCompany();
  const [tab, setTab] = useState<SettingsTab>("general");

  if (loading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load settings" description={error ?? undefined} />;
  }

  const base = `/portal/${company.slug}`;

  return (
    <>
      <PortalPageHeader title="Settings" description="Company profile and preferences." />

      <nav className="settings-tab-nav" aria-label="Settings sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`settings-tab-btn${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {!item.available ? " · Soon" : ""}
          </button>
        ))}
      </nav>

      {tab === "general" ? (
        <SectionCard title="Company profile">
          <KeyValue label="Company" value={company.name} />
          <KeyValue label="Domain" value={company.primaryDomain ?? "—"} />
          <KeyValue label="Status" value={<StatusBadge status={company.status} />} />
          <KeyValue label="Your role" value={humanRole(membership?.role)} />
          <KeyValue label="Portal address" value={company.portalSubdomain ?? company.slug} />
        </SectionCard>
      ) : null}

      {tab === "notifications" ? (
        <SectionCard title="Notifications">
          <Notice tone="info">
            Email and in-app notification preferences will appear here when available.
          </Notice>
        </SectionCard>
      ) : null}

      {tab === "security" ? (
        <SectionCard title="Security">
          <KeyValue label="Access control" value="Role-based permissions per user" />
          <KeyValue label="AI connections" value="Bearer tokens — revocable from the AI page" />
          <KeyValue label="Financial actions" value="Approval required for sensitive writes" />
          <div style={{ marginTop: 16 }}>
            <Notice tone="info">
              SSO, MFA enforcement, and session management are planned for a future release.
            </Notice>
          </div>
        </SectionCard>
      ) : null}

      {tab === "billing" ? (
        <SectionCard title="Billing preferences">
          <p className="muted small">
            Manage wallet balance, top-ups, and transaction history from the{" "}
            <Link to={`${base}/billing`}>Billing</Link> page.
          </p>
          <div style={{ marginTop: 12 }}>
            <Notice tone="info">
              Auto top-up and monthly spending caps are designed but not yet enabled.
            </Notice>
          </div>
        </SectionCard>
      ) : null}

      {tab === "integrations" ? (
        <SectionCard title="AI & integrations">
          <p className="muted small">
            Connect business systems from <Link to={`${base}/connectors`}>Connections</Link> and
            manage AI clients from <Link to={`${base}/ai-connections`}>AI</Link>.
          </p>
        </SectionCard>
      ) : null}

      {tab === "data" ? (
        <SectionCard title="Data & privacy">
          <Notice tone="info">
            Data retention policies and export requests will be configurable here in a future
            release.
          </Notice>
        </SectionCard>
      ) : null}

      {tab === "branding" ? (
        <SectionCard title="Branding">
          <Notice tone="info">
            Custom logos, colours, and portal domains will appear here when white-labelling is
            available.
          </Notice>
        </SectionCard>
      ) : null}

      {tab === "advanced" ? (
        <SectionCard title="Advanced">
          <KeyValue label="Company slug" value={company.slug} />
          <KeyValue label="Company ID" value={company.id} />
          <div style={{ marginTop: 16 }}>
            <Notice tone="info">
              Platform-level settings are only available in the Control Plane for INFRA operators.
            </Notice>
          </div>
        </SectionCard>
      ) : null}
    </>
  );
}
