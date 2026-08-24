import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Plus } from "lucide-react";
import type { Company, ConnectorInstance, McpEnvironment } from "@infra/shared";
import { api } from "../api";
import {
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

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "attention" | "disabled">("all");
  const [wizardOpen, setWizardOpen] = useState(false);

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
          <Button type="button" variant="primary" onClick={() => setWizardOpen(true)}>
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
            Disabled
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
              <Button type="button" variant="primary" onClick={() => setWizardOpen(true)}>
                Add company
              </Button>
            ) : undefined
          }
        />
      ) : filtered.length === 1 ? (
        <CompanyCard company={filtered[0]} />
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
                        to="/portal/dashboard"
                        className="button button-secondary button-small"
                      >
                        Portal
                      </Link>
                      <Link
                        to="/portal/ai-connections"
                        className="button button-primary button-small"
                      >
                        ChatGPT
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        title="Add company"
        description="Company provisioning will follow a guided onboarding flow."
        footer={
          <Button type="button" variant="secondary" onClick={() => setWizardOpen(false)}>
            Close
          </Button>
        }
      >
        <ol className="stack" style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
          <li>
            <strong style={{ color: "var(--text)" }}>Company</strong> — name, domain, timezone
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Administrator</strong> — invite the first admin
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Integrations</strong> — connect now or skip
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>AI access</strong> — ChatGPT, Claude, and more
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Review</strong> — create company
          </li>
        </ol>
        <p className="muted small" style={{ marginTop: 16 }}>
          Guided provisioning is not enabled in this release. Create companies via the control-plane
          API or seed process, then manage them here.
        </p>
        <Button
          type="button"
          variant="primary"
          style={{ marginTop: 12 }}
          onClick={() => {
            toast("Company wizard is prepared for a future release", "info");
            setWizardOpen(false);
          }}
        >
          Got it
        </Button>
      </Modal>
    </>
  );
}

function CompanyCard({ company }: { company: CompanyRow }) {
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
        <Link to="/portal/dashboard" className="button button-secondary button-small">
          Company portal
        </Link>
        <Link to="/portal/ai-connections" className="button button-primary button-small">
          ChatGPT connector
        </Link>
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
