import { CONNECTOR_CATALOGUE, getCapabilityDefinitions } from "@infra/shared";
import { PageHeader, SectionCard, StatusBadge } from "../components";

export default function CataloguePage() {
  return (
    <>
      <PageHeader
        title="Connector Catalogue"
        subtitle="Reusable connector implementations. Each company receives isolated instances with separate credentials and data environments."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Connector</th>
              <th>Category</th>
              <th>Capabilities</th>
              <th>Risk profile</th>
              <th>Sync modes</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            {CONNECTOR_CATALOGUE.map((connector) => {
              const caps = getCapabilityDefinitions(connector.capabilities);
              const risks = [...new Set(caps.map((c) => c.riskClass))];
              return (
                <tr key={connector.id}>
                  <td>
                    <div>{connector.name}</div>
                    <div className="muted">{connector.description}</div>
                  </td>
                  <td>{connector.category}</td>
                  <td>{connector.capabilities.join(", ")}</td>
                  <td>{risks.join(", ")}</td>
                  <td>{connector.supportedSyncModes.join(", ")}</td>
                  <td>
                    <StatusBadge value={connector.isAvailable ? "active" : "draft"} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SectionCard title="Personal connectors excluded">
        <p className="muted">
          INFRA focuses on business-shared systems (SharePoint, shared Drive, BigChange,
          Commusoft, Xero, shared Outlook, Freshdesk). Personal Gmail, personal Outlook,
          and personal calendars are not in scope.
        </p>
      </SectionCard>
    </>
  );
}
