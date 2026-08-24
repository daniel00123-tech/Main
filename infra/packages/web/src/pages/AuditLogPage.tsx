import { useEffect, useState } from "react";
import { api } from "../api";
import type { AuditEvent, Company } from "@infra/shared";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  formatDate,
} from "../components";

export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [auditEvents, companyList] = await Promise.all([
          api.getAuditEvents(),
          api.getCompanies(),
        ]);
        setEvents(auditEvents);
        setCompanies(companyList);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audit log");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  const companyById = new Map(companies.map((company) => [company.id, company.name]));

  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle="Administrative and security actions recorded by the control plane."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Actor</th>
              <th>Event</th>
              <th>Resource</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{event.companyId ? companyById.get(event.companyId) ?? event.companyId : "Platform"}</td>
                <td>{event.actor}</td>
                <td>{event.eventType}</td>
                <td className="mono">
                  {event.resourceType ? `${event.resourceType}:${event.resourceId ?? "—"}` : "—"}
                </td>
                <td>{formatDate(event.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
