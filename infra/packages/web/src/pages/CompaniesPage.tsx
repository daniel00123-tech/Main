import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Company } from "@infra/shared";
import { api } from "../api";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components";

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getCompanies()
      .then(setCompanies)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!companies.length) return <LoadingState />;

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
              <th>Notes</th>
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
                <td className="muted">{company.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
