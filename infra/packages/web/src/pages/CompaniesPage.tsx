import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Company } from "@infra/shared";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components";

interface CompanyRow extends Company {
  mcpCount?: number;
  connectorCount?: number;
  creditBalanceCents?: number;
}

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [companyList, mcpList, connectorList] = await Promise.all([
          api.getCompanies(),
          api.getMcpEnvironments(),
          api.getConnectorInstances(),
        ]);

        setCompanies(
          companyList.map((company) => ({
            ...company,
            mcpCount: mcpList.filter((mcp) => mcp.companyId === company.id).length,
            connectorCount: connectorList.filter(
              (connector) => connector.companyId === company.id,
            ).length,
          })),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load companies");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Registered tenants in the live INFRA control plane."
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
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => (
              <tr key={company.id}>
                <td>
                  <Link to={`/companies/${company.slug}`}>{company.name}</Link>
                </td>
                <td>{company.slug}</td>
                <td>
                  <StatusBadge value={company.status} />
                </td>
                <td>{company.primaryDomain ?? "—"}</td>
                <td>{company.mcpCount ?? 0}</td>
                <td>{company.connectorCount ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
