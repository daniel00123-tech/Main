import { Link } from "react-router-dom";
import { MOCK_COMPANIES } from "../mock-data";
import { PageHeader, StatusBadge, formatCurrency } from "../components";

export default function CompaniesPage() {
  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Development and demo tenants. Customer data remains isolated per company."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Status</th>
              <th>Domain</th>
              <th>MCP</th>
              <th>Connectors</th>
              <th>Credit Balance</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_COMPANIES.map((company) => (
              <tr key={company.id}>
                <td>
                  <Link to={`/companies/${company.slug}`}>{company.name}</Link>
                </td>
                <td>{company.slug}</td>
                <td>
                  <StatusBadge value={company.status} />
                </td>
                <td>{company.primaryDomain}</td>
                <td>
                  <StatusBadge value={company.mcpStatus} />
                </td>
                <td>
                  {company.connectorSummary.connected}/{company.connectorSummary.total}
                </td>
                <td>{formatCurrency(company.creditBalanceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
