import { CONNECTOR_CATALOGUE } from "@infra/shared";
import { PageHeader, SectionCard, StatusBadge } from "../components";
import { ErrorState, LoadingState } from "../components";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalConnectorsPage() {
  const { company, overview, loading, error } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !overview) {
    return <ErrorState message={error ?? "Connectors unavailable"} />;
  }

  const catalogueById = new Map(CONNECTOR_CATALOGUE.map((item) => [item.id, item]));

  return (
    <>
      <PageHeader
        title="Connectors"
        subtitle={`Business systems registered for ${company.name}. Live connections are not enabled in Phase 1.`}
      />

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>System</th>
              <th>Category</th>
              <th>Status</th>
              <th>Health</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {overview.connectorInstances.map((connector) => {
              const definition = catalogueById.get(connector.connectorDefinitionId);
              return (
                <tr key={connector.id}>
                  <td>{connector.name}</td>
                  <td>{definition?.category ?? "—"}</td>
                  <td>
                    <StatusBadge value={connector.status} />
                  </td>
                  <td>
                    <StatusBadge value={connector.healthStatus} />
                  </td>
                  <td>
                    <span className="prototype-badge">Not connected in Phase 1</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SectionCard title="How connections work">
        <div className="grid grid-2">
          <div>
            <h4>Phase 1 — Registry only</h4>
            <p className="muted">
              Connector instances are registered in INFRA but not connected to live
              business systems yet. Status and health reflect configuration state only.
            </p>
          </div>
          <div>
            <h4>Later — Self-service</h4>
            <p className="muted">
              Company admins will connect systems with secure credential storage.
              Staff permissions are enforced server-side regardless of AI client.
            </p>
          </div>
        </div>
      </SectionCard>
    </>
  );
}
