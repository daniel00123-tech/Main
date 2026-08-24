import { useEffect, useState } from "react";
import type { ConnectorDefinition } from "@infra/shared";
import { api } from "../api";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components";

export default function CataloguePage() {
  const [connectors, setConnectors] = useState<ConnectorDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getConnectorCatalogue()
      .then(setConnectors)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!connectors.length) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="Connector Catalogue"
        subtitle="Reusable connector implementations. Each company receives isolated connector instances with separate credentials and data environments."
      />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Connector</th>
              <th>Category</th>
              <th>Capabilities</th>
              <th>Sync Modes</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            {connectors.map((connector) => (
              <tr key={connector.id}>
                <td>
                  <div>{connector.name}</div>
                  <div className="muted">{connector.description}</div>
                </td>
                <td>{connector.category}</td>
                <td>{connector.capabilities.join(", ")}</td>
                <td>{connector.supportedSyncModes.join(", ")}</td>
                <td>
                  <StatusBadge value={connector.isAvailable ? "active" : "draft"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
