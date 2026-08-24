import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Building2, Plus } from "lucide-react";
import type { Company, ConnectorInstance, CreateCompanyInput, McpEnvironment } from "@infra/shared";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import {
  ActionMenu,
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChip,
  LoadingState,
  MetricCard,
  MetricGrid,
  Modal,
  PageHeader,
  SearchInput,
  StatusBadge,
  toast,
} from "../components";
import { formatNumber } from "../lib/format";

interface CompanyRow extends Company {
  mcpCount: number;
  connectorCount: number;
  connectedCount: number;
  mcpStatus: string | null;
  needsAttention: boolean;
}

type WizardStep = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS = [
  "Company details",
  "Tenant identity",
  "Commercial",
  "Admin invite",
  "Review",
] as const;

const INITIAL_FORM = {
  legalName: "",
  tradingName: "",
  companyNumber: "",
  country: "GB",
  timezone: "Europe/London",
  primaryContactName: "",
  primaryEmail: "",
  billingEmail: "",
  telephone: "",
  slug: "",
  portalSubdomain: "",
  openingCreditPounds: "0",
  currency: "GBP",
  adminEmail: "",
  adminDisplayName: "",
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}

export default function CompaniesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "attention" | "disabled">("all");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>(1);
  const [form, setForm] = useState(INITIAL_FORM);
  const [slugTouched, setSlugTouched] = useState(false);
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [suspendingSlug, setSuspendingSlug] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [companyList, mcpList, connectorList] = await Promise.all([
        api.getCompanies(),
        api.getMcpEnvironments(),
        api.getConnectorInstances(),
      ]);
      setCompanies(buildRows(companyList, mcpList, connectorList));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load companies");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return companies.filter((c) => {
      if (filter === "active" && c.status !== "active") return false;
      if (filter === "disabled" && c.status !== "suspended") return false;
      if (filter === "attention" && !c.needsAttention) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q) ||
        (c.primaryDomain ?? "").toLowerCase().includes(q)
      );
    });
  }, [companies, query, filter]);

  const stats = useMemo(() => {
    const active = companies.filter((c) => c.status === "active").length;
    const connected = companies.filter((c) => c.connectedCount > 0 || c.mcpCount > 0).length;
    const attention = companies.filter((c) => c.needsAttention).length;
    return { total: companies.length, active, connected, attention };
  }, [companies]);

  const derivedSlug = useMemo(
    () => slugify(form.tradingName || form.legalName),
    [form.tradingName, form.legalName],
  );
  const effectiveSlug = slugTouched ? slugify(form.slug) : derivedSlug;
  const derivedSubdomain = useMemo(() => {
    const base = effectiveSlug.split("-")[0] || effectiveSlug;
    return slugify(base) || "company";
  }, [effectiveSlug]);
  const effectiveSubdomain = subdomainTouched
    ? slugify(form.portalSubdomain) || derivedSubdomain
    : derivedSubdomain;

  function openWizard() {
    setForm(INITIAL_FORM);
    setStep(1);
    setSlugTouched(false);
    setSubdomainTouched(false);
    setFormError(null);
    setCreatedSlug(null);
    setSubmitting(false);
    setWizardOpen(true);
  }

  function closeWizard() {
    setWizardOpen(false);
    setFormError(null);
    setCreatedSlug(null);
    setSubmitting(false);
  }

  function updateField<K extends keyof typeof INITIAL_FORM>(key: K, value: (typeof INITIAL_FORM)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFormError(null);
  }

  function validateStep(current: WizardStep): string | null {
    if (current === 1) {
      if (!form.legalName.trim()) return "Legal name is required";
      if (form.primaryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.primaryEmail.trim())) {
        return "Primary email looks invalid";
      }
      if (form.billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.billingEmail.trim())) {
        return "Billing email looks invalid";
      }
    }
    if (current === 2) {
      if (!effectiveSlug) return "Slug is required";
      if (!effectiveSubdomain) return "Portal subdomain is required";
    }
    if (current === 3) {
      const pounds = Number(form.openingCreditPounds);
      if (!Number.isFinite(pounds) || pounds < 0) {
        return "Opening credit must be zero or a positive amount in pounds";
      }
    }
    if (current === 4) {
      if (form.adminEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.adminEmail.trim())) {
        return "Admin email looks invalid";
      }
      if (form.adminEmail.trim() && !form.adminDisplayName.trim()) {
        return "Admin display name is required when inviting an admin";
      }
    }
    return null;
  }

  function goNext() {
    const err = validateStep(step);
    if (err) {
      setFormError(err);
      return;
    }
    if (step === 1 && !slugTouched) {
      setForm((prev) => ({ ...prev, slug: derivedSlug }));
    }
    if (step === 1 && !subdomainTouched) {
      const base = (slugTouched ? slugify(form.slug) : derivedSlug).split("-")[0] || derivedSlug;
      setForm((prev) => ({ ...prev, portalSubdomain: slugify(base) || "company" }));
    }
    setFormError(null);
    setStep((s) => Math.min(5, s + 1) as WizardStep);
  }

  function goBack() {
    setFormError(null);
    setStep((s) => Math.max(1, s - 1) as WizardStep);
  }

  async function createCompany() {
    for (const s of [1, 2, 3, 4] as WizardStep[]) {
      const err = validateStep(s);
      if (err) {
        setStep(s);
        setFormError(err);
        return;
      }
    }

    const pounds = Number(form.openingCreditPounds) || 0;
    const input: CreateCompanyInput = {
      legalName: form.legalName.trim(),
      tradingName: form.tradingName.trim() || null,
      companyNumber: form.companyNumber.trim() || null,
      country: form.country.trim() || "GB",
      timezone: form.timezone.trim() || "Europe/London",
      primaryContactName: form.primaryContactName.trim() || null,
      primaryEmail: form.primaryEmail.trim() || null,
      billingEmail: form.billingEmail.trim() || null,
      telephone: form.telephone.trim() || null,
      slug: effectiveSlug || null,
      portalSubdomain: effectiveSubdomain || null,
      openingCreditCents: Math.round(pounds * 100),
      currency: form.currency || "GBP",
      adminEmail: form.adminEmail.trim() || null,
      adminDisplayName: form.adminDisplayName.trim() || null,
    };

    setSubmitting(true);
    setFormError(null);
    try {
      const result = await api.createCompany(input);
      const slug = result.company.slug;
      setCreatedSlug(slug);
      toast(`Company “${result.company.name}” created`);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to create company");
    } finally {
      setSubmitting(false);
    }
  }

  async function suspendCompany(slug: string) {
    setSuspendingSlug(slug);
    try {
      await api.setCompanyStatus(slug, "suspended");
      toast("Company suspended");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to suspend company", "error");
    } finally {
      setSuspendingSlug(null);
    }
  }

  if (loading) return <LoadingState label="Loading companies…" />;
  if (error) {
    return <ErrorState title="Unable to load companies" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="Companies"
        description="Manage organisations connected to INFRA."
        actions={
          <Button type="button" variant="primary" onClick={openWizard}>
            <Plus size={16} /> Add company
          </Button>
        }
      />

      <MetricGrid cols={4}>
        <MetricCard label="Total" value={formatNumber(stats.total)} />
        <MetricCard label="Active" value={formatNumber(stats.active)} />
        <MetricCard label="Connected" value={formatNumber(stats.connected)} hint="Has gateway or connector" />
        <MetricCard label="Attention" value={formatNumber(stats.attention)} />
      </MetricGrid>

      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search companies…" className="grow" />
        <div className="filter-chips">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={stats.total}>
            All
          </FilterChip>
          <FilterChip active={filter === "active"} onClick={() => setFilter("active")} count={stats.active}>
            Active
          </FilterChip>
          <FilterChip active={filter === "attention"} onClick={() => setFilter("attention")} count={stats.attention}>
            Needs attention
          </FilterChip>
          <FilterChip active={filter === "disabled"} onClick={() => setFilter("disabled")}>
            Suspended
          </FilterChip>
        </div>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Building2 size={28} />}
          title={companies.length === 0 ? "No companies yet" : "No matching companies"}
          description={
            companies.length === 0
              ? "Create your first company to start connecting business systems to INFRA."
              : "Try a different search or filter."
          }
          action={
            companies.length === 0 ? (
              <Button type="button" variant="primary" onClick={openWizard}>
                Add company
              </Button>
            ) : undefined
          }
        />
      ) : filtered.length === 1 ? (
        <CompanyCard
          company={filtered[0]}
          isPlatformAdmin={Boolean(user?.isPlatformAdmin)}
          suspending={suspendingSlug === filtered[0].slug}
          onSuspend={() => void suspendCompany(filtered[0].slug)}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Connectors</th>
                <th>AI Gateway</th>
                <th>Domain</th>
                <th>Portal</th>
                {user?.isPlatformAdmin ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {filtered.map((company) => (
                <tr key={company.id}>
                  <td>
                    <Link to={`/companies/${company.slug}`} style={{ fontWeight: 600 }}>
                      {company.name}
                    </Link>
                    {company.needsAttention ? (
                      <div className="warning-text">Needs attention</div>
                    ) : null}
                  </td>
                  <td>
                    <StatusBadge status={company.status} />
                  </td>
                  <td>
                    {company.connectedCount}/{company.connectorCount}
                  </td>
                  <td>
                    {company.mcpStatus ? <StatusBadge status={company.mcpStatus} /> : <span className="muted">None</span>}
                  </td>
                  <td className="muted">{company.primaryDomain ?? "—"}</td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      <Link
                        to={`/portal/${company.slug}/dashboard`}
                        className="button button-secondary button-small"
                      >
                        Portal
                      </Link>
                      <Link
                        to={`/portal/${company.slug}/ai-connections`}
                        className="button button-primary button-small"
                      >
                        ChatGPT
                      </Link>
                    </div>
                  </td>
                  {user?.isPlatformAdmin ? (
                    <td>
                      <ActionMenu
                        items={[
                          {
                            label: suspendingSlug === company.slug ? "Suspending…" : "Suspend",
                            danger: true,
                            disabled:
                              company.status === "suspended" ||
                              company.status === "closed" ||
                              suspendingSlug === company.slug,
                            onClick: () => void suspendCompany(company.slug),
                          },
                        ]}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={wizardOpen}
        onClose={closeWizard}
        title={createdSlug ? "Company created" : "Add company"}
        description={
          createdSlug
            ? "Provisioning complete. Open the portal or company detail next."
            : `Step ${step} of 5 — ${STEP_LABELS[step - 1]}`
        }
        footer={
          createdSlug ? (
            <>
              <Button type="button" variant="secondary" onClick={closeWizard}>
                Done
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  closeWizard();
                  navigate(`/companies/${createdSlug}`);
                }}
              >
                Company detail
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  closeWizard();
                  navigate(`/portal/${createdSlug}/dashboard`);
                }}
              >
                Open portal
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" onClick={closeWizard} disabled={submitting}>
                Cancel
              </Button>
              {step > 1 ? (
                <Button type="button" variant="secondary" onClick={goBack} disabled={submitting}>
                  Back
                </Button>
              ) : null}
              {step < 5 ? (
                <Button type="button" variant="primary" onClick={goNext}>
                  Continue
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  loading={submitting}
                  onClick={() => void createCompany()}
                >
                  Create company
                </Button>
              )}
            </>
          )
        }
      >
        {createdSlug ? (
          <p className="muted" style={{ margin: 0 }}>
            Company slug <code className="mono">{createdSlug}</code> is ready.
          </p>
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            <ol
              className="filter-chips"
              style={{ listStyle: "none", margin: 0, padding: 0, flexWrap: "wrap" }}
            >
              {STEP_LABELS.map((label, index) => {
                const n = (index + 1) as WizardStep;
                const active = n === step;
                return (
                  <li
                    key={label}
                    className={`filter-chip${active ? " active" : ""}`}
                    style={{ cursor: "default", opacity: n > step ? 0.55 : 1 }}
                  >
                    {n}. {label}
                  </li>
                );
              })}
            </ol>

            {formError ? <div className="error-box">{formError}</div> : null}

            {step === 1 ? (
              <div className="form-grid">
                <label>
                  Legal name *
                  <input
                    value={form.legalName}
                    onChange={(e) => updateField("legalName", e.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  Trading name
                  <input
                    value={form.tradingName}
                    onChange={(e) => updateField("tradingName", e.target.value)}
                  />
                </label>
                <label>
                  Company number
                  <input
                    value={form.companyNumber}
                    onChange={(e) => updateField("companyNumber", e.target.value)}
                  />
                </label>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <label>
                    Country
                    <input
                      value={form.country}
                      onChange={(e) => updateField("country", e.target.value)}
                    />
                  </label>
                  <label>
                    Timezone
                    <input
                      value={form.timezone}
                      onChange={(e) => updateField("timezone", e.target.value)}
                    />
                  </label>
                </div>
                <label>
                  Primary contact
                  <input
                    value={form.primaryContactName}
                    onChange={(e) => updateField("primaryContactName", e.target.value)}
                  />
                </label>
                <label>
                  Primary email
                  <input
                    type="email"
                    value={form.primaryEmail}
                    onChange={(e) => updateField("primaryEmail", e.target.value)}
                  />
                </label>
                <label>
                  Billing email
                  <input
                    type="email"
                    value={form.billingEmail}
                    onChange={(e) => updateField("billingEmail", e.target.value)}
                  />
                </label>
                <label>
                  Telephone
                  <input
                    value={form.telephone}
                    onChange={(e) => updateField("telephone", e.target.value)}
                  />
                </label>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="form-grid">
                <label>
                  Slug
                  <input
                    value={slugTouched ? form.slug : effectiveSlug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      updateField("slug", e.target.value);
                    }}
                    className="mono"
                  />
                </label>
                <label>
                  Portal subdomain
                  <input
                    value={subdomainTouched ? form.portalSubdomain : effectiveSubdomain}
                    onChange={(e) => {
                      setSubdomainTouched(true);
                      updateField("portalSubdomain", e.target.value);
                    }}
                    className="mono"
                  />
                </label>
                <div className="info-banner" style={{ margin: 0 }}>
                  <div className="muted small">Portal path</div>
                  <code className="mono">/portal/{effectiveSlug || "…"}/dashboard</code>
                  <div className="muted small" style={{ marginTop: 8 }}>
                    Hostname
                  </div>
                  <code className="mono">
                    {effectiveSubdomain || "…"}.infra-web.pages.dev
                  </code>
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="form-grid">
                <label>
                  Opening credit (£)
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.openingCreditPounds}
                    onChange={(e) => updateField("openingCreditPounds", e.target.value)}
                  />
                </label>
                <label>
                  Currency
                  <input value={form.currency} readOnly />
                </label>
                <p className="muted small" style={{ margin: 0 }}>
                  Opening credit is stored in pence. £
                  {Number(form.openingCreditPounds) || 0} ={" "}
                  {Math.round((Number(form.openingCreditPounds) || 0) * 100)} cents.
                </p>
              </div>
            ) : null}

            {step === 4 ? (
              <div className="form-grid">
                <p className="muted small" style={{ margin: 0 }}>
                  Optional — invite the first company administrator now, or skip and invite later.
                </p>
                <label>
                  Admin email
                  <input
                    type="email"
                    value={form.adminEmail}
                    onChange={(e) => updateField("adminEmail", e.target.value)}
                  />
                </label>
                <label>
                  Admin display name
                  <input
                    value={form.adminDisplayName}
                    onChange={(e) => updateField("adminDisplayName", e.target.value)}
                  />
                </label>
              </div>
            ) : null}

            {step === 5 ? (
              <div className="stack" style={{ gap: 10 }}>
                <ReviewRow label="Legal name" value={form.legalName.trim()} />
                <ReviewRow
                  label="Trading name"
                  value={form.tradingName.trim() || form.legalName.trim()}
                />
                <ReviewRow label="Company number" value={form.companyNumber.trim() || "—"} />
                <ReviewRow label="Country" value={form.country.trim() || "GB"} />
                <ReviewRow label="Timezone" value={form.timezone.trim() || "Europe/London"} />
                <ReviewRow label="Primary contact" value={form.primaryContactName.trim() || "—"} />
                <ReviewRow label="Primary email" value={form.primaryEmail.trim() || "—"} />
                <ReviewRow label="Billing email" value={form.billingEmail.trim() || "—"} />
                <ReviewRow label="Telephone" value={form.telephone.trim() || "—"} />
                <ReviewRow label="Slug" value={effectiveSlug || "—"} mono />
                <ReviewRow
                  label="Portal subdomain"
                  value={`${effectiveSubdomain || "—"}.infra-web.pages.dev`}
                  mono
                />
                <ReviewRow
                  label="Opening credit"
                  value={`£${Number(form.openingCreditPounds) || 0} ${form.currency}`}
                />
                <ReviewRow
                  label="Admin invite"
                  value={
                    form.adminEmail.trim()
                      ? `${form.adminDisplayName.trim() || "Admin"} <${form.adminEmail.trim()}>`
                      : "Skipped"
                  }
                />
              </div>
            ) : null}
          </div>
        )}
      </Modal>
    </>
  );
}

function ReviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="drawer-row">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </div>
  );
}

function CompanyCard({
  company,
  isPlatformAdmin,
  suspending,
  onSuspend,
}: {
  company: CompanyRow;
  isPlatformAdmin: boolean;
  suspending: boolean;
  onSuspend: () => void;
}) {
  return (
    <div className="entity-card">
      <Link
        to={`/companies/${company.slug}`}
        style={{ display: "block", color: "inherit", textDecoration: "none" }}
      >
        <div className="connection-header">
          <div>
            <h3>{company.name}</h3>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              {company.primaryDomain ?? company.slug}
            </p>
          </div>
          <StatusBadge status={company.status} />
        </div>
        <div className="grid grid-3" style={{ marginTop: 12 }}>
          <div>
            <div className="muted small">Connectors</div>
            <div style={{ fontWeight: 600 }}>
              {company.connectedCount}/{company.connectorCount}
            </div>
          </div>
          <div>
            <div className="muted small">AI Gateway</div>
            <div>{company.mcpStatus ? <StatusBadge status={company.mcpStatus} /> : "—"}</div>
          </div>
          <div>
            <div className="muted small">Attention</div>
            <div style={{ fontWeight: 600 }}>{company.needsAttention ? "Yes" : "None"}</div>
          </div>
        </div>
      </Link>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
        <Link
          to={`/portal/${company.slug}/dashboard`}
          className="button button-secondary button-small"
        >
          Company portal
        </Link>
        <Link
          to={`/portal/${company.slug}/ai-connections`}
          className="button button-primary button-small"
        >
          ChatGPT connector
        </Link>
        {isPlatformAdmin && company.status !== "suspended" && company.status !== "closed" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={suspending}
            onClick={onSuspend}
          >
            Suspend
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function buildRows(
  companies: Company[],
  mcps: McpEnvironment[],
  connectors: ConnectorInstance[],
): CompanyRow[] {
  return companies.map((company) => {
    const companyMcps = mcps.filter((m) => m.companyId === company.id);
    const companyConnectors = connectors.filter((c) => c.companyId === company.id);
    const connectedCount = companyConnectors.filter((c) =>
      ["connected", "active", "healthy"].includes(c.status) ||
      ["healthy", "connected"].includes(c.healthStatus ?? ""),
    ).length;
    const badMcp = companyMcps.find((m) => ["unreachable", "degraded"].includes(m.status));
    return {
      ...company,
      mcpCount: companyMcps.length,
      connectorCount: companyConnectors.length,
      connectedCount,
      mcpStatus: companyMcps[0]?.status ?? null,
      needsAttention: Boolean(badMcp) || company.status === "suspended",
    };
  });
}
