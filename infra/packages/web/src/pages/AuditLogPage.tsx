import { MOCK_AUDIT } from "../mock-data";
import { PageHeader, StatusBadge, formatDate } from "../components";

export default function AuditLogPage() {
  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle="Observable administrative and system actions. No model chain-of-thought stored."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Actor</th>
              <th>Event</th>
              <th>Resource</th>
              <th>Result</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_AUDIT.map((event) => (
              <tr key={event.id}>
                <td>{event.company}</td>
                <td>{event.actor}</td>
                <td>{event.eventType}</td>
                <td className="mono">{event.resource}</td>
                <td>
                  <StatusBadge value="completed" />
                  {event.result}
                </td>
                <td>{formatDate(event.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
