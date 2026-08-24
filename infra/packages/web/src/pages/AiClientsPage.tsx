import { Link } from "react-router-dom";
import { MOCK_AI_CLIENTS } from "../mock-data";
import { PageHeader, StatusBadge } from "../components";

export default function AiClientsPage() {
  return (
    <>
      <PageHeader
        title="AI Clients"
        subtitle="Staff-facing interfaces that connect to company MCP environments. INFRA does not rebuild ChatGPT or Claude."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Client</th>
              <th>Status</th>
              <th>MCP Environment</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_AI_CLIENTS.map((client) => (
              <tr key={client.id}>
                <td>
                  {client.companySlug ? (
                    <Link to={`/companies/${client.companySlug}`}>
                      {client.company}
                    </Link>
                  ) : (
                    client.company
                  )}
                </td>
                <td>{client.client}</td>
                <td>
                  <StatusBadge
                    value={
                      client.status === "connected"
                        ? "healthy"
                        : client.status === "coming_later"
                          ? "draft"
                          : "registered"
                    }
                  />
                </td>
                <td>{client.mcpEnvironment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
