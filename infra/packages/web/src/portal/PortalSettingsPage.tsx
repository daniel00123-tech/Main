import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Button,
  ErrorState,
  Input,
  KeyValue,
  LoadingState,
  Notice,
  SectionCard,
  StatusBadge,
} from "../components";
import { api } from "../api";
import { humanRole } from "../lib/format";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

type SettingsTab = "general" | "security" | "advanced";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "Company" },
  { id: "security", label: "Security & access" },
  { id: "advanced", label: "Advanced" },
];

export default function PortalSettingsPage() {
  const { company, membership, loading, error, refresh } = usePortalCompany();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryContact, setPrimaryContact] = useState("");
  const [primaryEmail, setPrimaryEmail] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [telephone, setTelephone] = useState("");
  const [timezone, setTimezone] = useState("Europe/London");
  const [lowBalanceThreshold, setLowBalanceThreshold] = useState("5");

  const canManage =
    membership?.role === "company_admin" ||
    membership?.role === "director";

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        const result = await api.getCompanySettings(company.slug);
        setSettings(result.settings);
        setName(String(result.settings.name ?? company.name));
        setLogoUrl(String(result.settings.logoUrl ?? company.logoUrl ?? ""));
        setPrimaryContact(String(result.settings.primaryContactName ?? ""));
        setPrimaryEmail(String(result.settings.primaryEmail ?? ""));
        setBillingEmail(String(result.settings.billingEmail ?? ""));
        setTelephone(String(result.settings.telephone ?? ""));
        setTimezone(String(result.settings.timezone ?? "Europe/London"));
        setLowBalanceThreshold(
          String(Number(result.settings.lowBalanceThresholdCents ?? 500) / 100),
        );
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load settings");
      }
    })();
  }, [company]);

  async function onSaveGeneral(event: FormEvent) {
    event.preventDefault();
    if (!company || !canManage) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.updateCompanySettings(company.slug, {
        name,
        logoUrl: logoUrl.trim() || null,
        primaryContactName: primaryContact || null,
        primaryEmail: primaryEmail || null,
        billingEmail: billingEmail || null,
        telephone: telephone || null,
        timezone,
        lowBalanceThresholdCents: Math.round(Number(lowBalanceThreshold) * 100) || 500,
      });
      setSettings(result.settings);
      setMessage("Settings saved.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save settings");
    } finally {
      setBusy(false);
    }
  }

  if (loading || (!settings && !loadError && !error)) {
    return <LoadingState label="Loading settings…" />;
  }
  if (error || loadError || !company) {
    return <ErrorState title="Unable to load settings" description={error ?? loadError ?? undefined} />;
  }

  const base = `/portal/${company.slug}`;

  return (
    <div className="portal-page">
      <PortalPageHeader title="Settings" description="Company profile, security, and preferences." />

      <nav className="settings-tab-nav" aria-label="Settings sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`settings-tab-btn${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {message ? <Notice tone="info">{message}</Notice> : null}

      {tab === "general" ? (
        <SectionCard title="Company profile">
          {canManage ? (
            <form onSubmit={(e) => void onSaveGeneral(e)} className="form-stack portal-settings-form">
              <label className="field">
                <span className="field-label">Company name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </label>
              <label className="field">
                <span className="field-label">Logo URL</span>
                <Input
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://…"
                />
                <span className="muted small">
                  Optional HTTPS image. If empty, the portal shows company initials.
                </span>
              </label>
              <label className="field">
                <span className="field-label">Primary contact</span>
                <Input value={primaryContact} onChange={(e) => setPrimaryContact(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Primary email</span>
                <Input type="email" value={primaryEmail} onChange={(e) => setPrimaryEmail(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Billing email</span>
                <Input type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Telephone</span>
                <Input value={telephone} onChange={(e) => setTelephone(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Timezone</span>
                <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Low balance alert threshold (£)</span>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={lowBalanceThreshold}
                  onChange={(e) => setLowBalanceThreshold(e.target.value)}
                />
              </label>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                Save changes
              </Button>
            </form>
          ) : (
            <>
              <KeyValue label="Company" value={company.name} />
              <KeyValue label="Status" value={<StatusBadge status={company.status} />} />
              <KeyValue label="Your role" value={humanRole(membership?.role)} />
            </>
          )}
          <div className="portal-settings-links">
            <p className="muted small">
              Manage users from <Link to={`${base}/users`}>Users</Link>, connected systems from{" "}
              <Link to={`${base}/connectors`}>Connections</Link>, AI from{" "}
              <Link to={`${base}/ai-connections`}>AI Access</Link>, and billing from{" "}
              <Link to={`${base}/billing`}>Billing</Link>.
            </p>
          </div>
        </SectionCard>
      ) : null}

      {tab === "security" ? (
        <SectionCard title="Security & access">
          <KeyValue label="Access control" value="Role-based permissions per user" />
          <KeyValue label="AI connections" value="Revocable from AI Access" />
          <KeyValue label="Financial actions" value="Approval required before writes" />
          <KeyValue
            label="Low balance alert"
            value={`£${lowBalanceThreshold}`}
          />
          <Notice tone="info">
            SSO and MFA enforcement are planned for a future release.
          </Notice>
        </SectionCard>
      ) : null}

      {tab === "advanced" ? (
        <SectionCard title="Advanced">
          <Notice tone="info">
            Technical identifiers are for support and operator troubleshooting only.
          </Notice>
          <KeyValue label="Company slug" value={company.slug} />
          <KeyValue label="Company ID" value={company.id} />
        </SectionCard>
      ) : null}
    </div>
  );
}
