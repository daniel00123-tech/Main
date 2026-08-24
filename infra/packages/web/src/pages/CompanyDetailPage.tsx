import { Link, useParams } from "react-router-dom";
import { MOCK_COMPANIES, MOCK_COMPANY_DETAIL } from "../mock-data";
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  formatCurrency,
} from "../components";

const TABS = [
  "Overview",
  "Connectors",
  "AI Clients",
  "Knowledge",
  "Structured Data",
  "Users & Permissions",
  "Usage",
  "Billing",
  "Health",
  "Audit Log",
] as const;

export default function CompanyDetailPage() {
  const { slug = "" } = useParams();
  const company = MOCK_COMPANIES.find((c) => c.slug === slug);
  const detail = MOCK_COMPANY_DETAIL[slug];

  if (!company) {
    return <div className="error-box">Company not found.</div>;
  }

  return (
    <>
      <PageHeader
        title={company.name}
        subtitle={`Status: ${company.status} · Domain: ${company.primaryDomain}`}
      />

      <div className="tab-bar">
        {TABS.map((tab) => (
          <span key={tab} className={`tab ${tab === "Overview" ? "active" : ""}`}>
            {tab}
          </span>
        ))}
      </div>

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric-card">
          <h3>Status</h3>
          <StatusBadge value={company.status} />
        </div>
        <div className="card metric-card">
          <h3>MCP</h3>
          <StatusBadge value={company.mcpStatus} />
        </div>
        <div className="card metric-card">
          <h3>Connectors</h3>
          <div className="metric">
            {company.connectorSummary.connected}/{company.connectorSummary.total}
          </div>
        </div>
        <div className="card metric-card">
          <h3>Credit Balance</h3>
          <div className="metric">{formatCurrency(company.creditBalanceCents)}</div>
        </div>
      </div>

      <div className="grid grid-2">
        {detail?.businessSystems.length ? (
          <SectionCard title="Business Systems">
            <table className="table">
              <tbody>
                {detail.businessSystems.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td className="muted">{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
        ) : null}

        <SectionCard title="Knowledge">
          <table className="table">
            <tbody>
              {detail?.knowledge.map((k) => (
                <tr key={k.name}>
                  <td>{k.name}</td>
                  <td className="muted">{k.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="AI Interfaces">
          <table className="table">
            <tbody>
              {detail?.aiInterfaces.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td>
                    <StatusBadge
                      value={
                        a.status === "Connected"
                          ? "healthy"
                          : a.status === "Coming later"
                            ? "draft"
                            : "registered"
                      }
                    />
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {a.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Structured Data">
          <table className="table">
            <tbody>
              {detail?.structuredData.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className="muted">{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      {slug === "caddington-holdings" ? (
        <div className="card" style={{ marginTop: 24 }}>
          <p className="muted">
            Caddington MCP is registered as an external environment. INFRA monitors it
            but does not modify the existing knowledge stack (R2, D1, Vectorize, FTS).
          </p>
          <Link to="/billing">View simulated billing →</Link>
        </div>
      ) : null}
    </>
  );
}
